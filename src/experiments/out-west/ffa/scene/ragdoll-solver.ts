/*
 * Gauss-Seidel iteration adapted from cannon-es 0.20.0, retaining its arithmetic order.
 * Inverse-mass Jacobian responses are constant during a solve and cached once per row.
 *
 * Copyright (c) 2015 cannon.js Authors
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import {
  Body,
  ConeTwistConstraint,
  ContactEquation,
  Equation,
  FrictionEquation,
  GSSolver,
  RotationalEquation,
  RotationalMotorEquation,
  Vec3,
  type World,
} from 'cannon-es'
import { GS_ROW_WIDTH, GsKernel } from './ragdoll-gs.ts'

// Per-row doubles: A/B spatial + angular Jacobians (12), inverse-inertia angular
// responses (6), RHS, inverse denominator, epsilon, force bounds and accumulated impulse.
const ROW_WIDTH = GS_ROW_WIDTH
const RHS = 18
const INV_C = 19
const EPS = 20
const MIN_FORCE = 21
const MAX_FORCE = 22
const LAMBDA = 23
// Reserved typed-array ranges contain numbers. A broken offset remains NaN, never a false zero.
const read = (values: Float64Array, index: number): number => values[index] ?? Number.NaN
const indexAt = (values: Int32Array, index: number): number => values[index] ?? -1

function finiteResponse(rows: Float64Array, at: number, a: number, b: number): boolean {
  if (!(Number.isFinite(a) && Number.isFinite(b))) {
    return false
  }
  for (let i = 0; i < 18; i++) {
    if (!Number.isFinite(read(rows, at + i))) {
      return false
    }
  }
  return true
}

function store(values: Float64Array, offset: number, v: Vec3): void {
  values[offset] = v.x
  values[offset + 1] = v.y
  values[offset + 2] = v.z
}

function dot(values: Float64Array, offset: number, velocity: Float64Array, at: number): number {
  return (
    read(values, offset) * read(velocity, at) +
    read(values, offset + 1) * read(velocity, at + 1) +
    read(values, offset + 2) * read(velocity, at + 2)
  )
}

// ConeEquation is internal to Cannon; obtain its stock method once from its public constraint.
const knownRhs = new Set<Equation['computeB']>([
  ContactEquation.prototype.computeB,
  FrictionEquation.prototype.computeB,
  RotationalEquation.prototype.computeB,
  RotationalMotorEquation.prototype.computeB,
  new ConeTwistConstraint(new Body(), new Body()).coneEquation.computeB,
])

function supportedRow(row: Equation, world: World): boolean {
  return (
    knownRhs.has(row.computeB) &&
    row.computeC === Equation.prototype.computeC &&
    row.computeGiMGt === Equation.prototype.computeGiMGt &&
    row.computeGW === Equation.prototype.computeGW &&
    row.computeGiMf === Equation.prototype.computeGiMf &&
    row.computeGq === Equation.prototype.computeGq &&
    row.computeGWlambda === Equation.prototype.computeGWlambda &&
    row.addToWlambda === Equation.prototype.addToWlambda &&
    world.bodies[row.bi.index] === row.bi &&
    world.bodies[row.bj.index] === row.bj
  )
}

export class CorpseSolver extends GSSolver {
  readonly stats = {
    calls: 0,
    equations: 0,
    contacts: 0,
    friction: 0,
    constraints: 0,
    iterations: 0,
    zeroDeltas: 0,
    backend: 'javascript',
    kernelBytes: 0,
    nativeCalls: 0,
    primed: false,
  }
  private kernel: GsKernel | null
  private rows = new Float64Array(0)
  private indices = new Int32Array(0)
  private finite = new Uint8Array(0)
  private velocities = new Float64Array(0)
  private masses = new Float64Array(0)
  private readonly response = new Vec3()
  private responders = new Int32Array(0)
  private zeros = new Int32Array(0)
  private responderCount = 0
  private zeroCount = 0
  private zeroDeltas = 0

  constructor(module?: WebAssembly.Module | null) {
    super()
    this.kernel = module ? GsKernel.create(module) : null
    this.stats.kernelBytes = this.kernel?.bytes ?? 0
  }

  override solve(dt: number, world: World): number {
    // Keep Cannon's extension contract: a custom row with different iteration methods or a
    // body outside this world uses the stock path. Production contacts/joints use Equation's.
    const supported = this.equations.every((row) => supportedRow(row, world))
    this.stats.backend = 'javascript'
    const iterations = supported ? this.solveCached(dt, world) : super.solve(dt, world)
    if (world.doProfiling) {
      const count = this.equations.length
      this.stats.calls++
      this.stats.equations = count
      this.stats.contacts = world.contacts.length
      this.stats.friction = world.frictionEquations.length
      this.stats.constraints = Math.max(
        0,
        count - world.contacts.length - world.frictionEquations.length,
      )
      this.stats.iterations = count === 0 ? 0 : Math.min(this.iterations, iterations + 1)
      this.stats.zeroDeltas = this.zeroDeltas
    }
    return iterations
  }

  private allocate(count: number, bodies: number): void {
    if (this.rows.length < count * ROW_WIDTH) {
      const rows = new Float64Array(count * ROW_WIDTH)
      const indices = new Int32Array(count * 2)
      const finite = new Uint8Array(count)
      this.rows = rows
      this.indices = indices
      this.finite = finite
    }
    if (this.velocities.length < bodies * 6) {
      const velocities = new Float64Array(bodies * 6)
      const masses = new Float64Array(bodies)
      const responders = new Int32Array(bodies)
      const zeros = new Int32Array(bodies)
      this.velocities = velocities
      this.masses = masses
      this.responders = responders
      this.zeros = zeros
    }
  }

  reserve(rows: number, bodies: number): boolean {
    if (!(Number.isSafeInteger(rows) && Number.isSafeInteger(bodies)) || rows < 0 || bodies < 0) {
      return false
    }
    try {
      this.allocate(rows, bodies)
      this.kernel?.run({
        count: rows,
        iterations: 0,
        tolerance: 0,
        rows: this.rows,
        indices: this.indices,
        velocities: this.velocities,
        masses: this.masses,
        finite: this.finite,
      })
      this.stats.kernelBytes = this.kernel?.bytes ?? 0
      return true
    } catch (error: unknown) {
      if (error instanceof RangeError) {
        return false
      }
      throw error
    }
  }

  private prepare(dt: number, world: World): void {
    const count = this.equations.length
    this.allocate(count, world.bodies.length)
    this.velocities.fill(0, 0, world.bodies.length * 6)
    this.responderCount = 0
    this.zeroCount = 0
    for (const [i, body] of world.bodies.entries()) {
      body.updateSolveMassProperties()
      this.masses[i] = body.invMassSolve
      if (
        body.invMassSolve !== 0 ||
        body.invInertiaWorldSolve.elements.some((value) => value !== 0)
      ) {
        this.responders[this.responderCount++] = i
      } else {
        this.zeros[this.zeroCount++] = i
      }
    }
    const rows = this.rows
    for (const [i, row] of this.equations.entries()) {
      const o = i * ROW_WIDTH
      // Cannon calls the runtime one-argument overload (Contact/Friction/RotationalEquation).
      // Reflect preserves that exact call even though the base Equation declaration has3 args.
      rows[o + RHS] = Reflect.apply(row.computeB, row, [dt])
      rows[o + EPS] = row.eps
      rows[o + MIN_FORCE] = row.minForce
      rows[o + MAX_FORCE] = row.maxForce
      rows[o + LAMBDA] = 0
      store(rows, o, row.jacobianElementA.spatial)
      store(rows, o + 3, row.jacobianElementA.rotational)
      store(rows, o + 6, row.jacobianElementB.spatial)
      store(rows, o + 9, row.jacobianElementB.rotational)
      // Stock computeGiMGt adds these two responses in this order. Keep the same doubles
      // for iteration rather than multiplying each inverse inertia by its Jacobian twice.
      let denominator = row.bi.invMassSolve + row.bj.invMassSolve
      row.bi.invInertiaWorldSolve.vmult(row.jacobianElementA.rotational, this.response)
      store(rows, o + 12, this.response)
      denominator += this.response.dot(row.jacobianElementA.rotational)
      row.bj.invInertiaWorldSolve.vmult(row.jacobianElementB.rotational, this.response)
      store(rows, o + 15, this.response)
      denominator += this.response.dot(row.jacobianElementB.rotational)
      rows[o + INV_C] = 1 / (denominator + row.eps)
      this.finite[i] = Number(finiteResponse(rows, o, row.bi.invMassSolve, row.bj.invMassSolve))
      this.indices[i * 2] = row.bi.index
      this.indices[i * 2 + 1] = row.bj.index
    }
  }

  private iterate(count: number): number {
    const rows = this.rows
    const indices = this.indices
    const velocity = this.velocities
    let iteration = 0
    let zeroDeltas = 0
    for (; iteration < this.iterations; iteration++) {
      let total = 0
      for (let j = 0; j < count; j++) {
        const o = j * ROW_WIDTH
        const ai = indexAt(indices, j * 2)
        const bi = indexAt(indices, j * 2 + 1)
        const a = ai * 6
        const b = bi * 6
        // Keep the stock dot-product grouping and row order; no parallel/Jacobi relaxation.
        const Gw =
          dot(rows, o, velocity, a) +
          dot(rows, o + 3, velocity, a + 3) +
          (dot(rows, o + 6, velocity, b) + dot(rows, o + 9, velocity, b + 3))
        const lambda = read(rows, o + LAMBDA)
        let delta =
          read(rows, o + INV_C) * (read(rows, o + RHS) - Gw - read(rows, o + EPS) * lambda)
        if (lambda + delta < read(rows, o + MIN_FORCE)) {
          delta = read(rows, o + MIN_FORCE) - lambda
        } else if (lambda + delta > read(rows, o + MAX_FORCE)) {
          delta = read(rows, o + MAX_FORCE) - lambda
        }
        rows[o + LAMBDA] = lambda + delta
        total += Math.abs(delta)
        // With finite responses, an exactly zero impulse leaves the scratch velocities
        // unchanged. Invalid extension data must still take the original IEEE arithmetic.
        if (delta === 0 && this.finite[j]) {
          zeroDeltas++
          continue
        }
        this.add(a, o, read(this.masses, ai) * delta)
        this.add(b, o + 6, read(this.masses, bi) * delta)
        this.add(a + 3, o + 12, delta)
        this.add(b + 3, o + 15, delta)
      }
      if (total * total < this.tolerance * this.tolerance) {
        break
      }
    }
    this.zeroDeltas = zeroDeltas
    return iteration
  }

  private add(at: number, offset: number, scale: number): void {
    const values = this.velocities
    const row = this.rows
    values[at] = read(values, at) + scale * read(row, offset)
    values[at + 1] = read(values, at + 1) + scale * read(row, offset + 1)
    values[at + 2] = read(values, at + 2) + scale * read(row, offset + 2)
  }

  private commit(bodies: Body[], dt: number): void {
    for (let i = 0; i < this.responderCount; i++) {
      const index = indexAt(this.responders, i)
      const body = bodies[index]
      if (!body) {
        continue
      }
      const o = index * 6
      const velocity = this.velocities
      body.vlambda.set(read(velocity, o), read(velocity, o + 1), read(velocity, o + 2))
      body.wlambda.set(read(velocity, o + 3), read(velocity, o + 4), read(velocity, o + 5))
      body.vlambda.vmul(body.linearFactor, body.vlambda)
      body.velocity.vadd(body.vlambda, body.velocity)
      body.wlambda.vmul(body.angularFactor, body.wlambda)
      body.angularVelocity.vadd(body.wlambda, body.angularVelocity)
    }
    // Static, kinematic and sleeping bodies have exactly zero inverse solve mass/inertia.
    // Their accumulated response is zero. Preserve Cannon's final factor/zero-add semantics
    // (including signed zeros) without loading and multiplying six zero scratch values.
    for (let i = 0; i < this.zeroCount; i++) {
      const body = bodies[indexAt(this.zeros, i)]
      if (!body) {
        continue
      }
      body.vlambda.set(0 * body.linearFactor.x, 0 * body.linearFactor.y, 0 * body.linearFactor.z)
      body.wlambda.set(0 * body.angularFactor.x, 0 * body.angularFactor.y, 0 * body.angularFactor.z)
      body.velocity.vadd(body.vlambda, body.velocity)
      body.angularVelocity.vadd(body.wlambda, body.angularVelocity)
    }
    const inverseDt = 1 / dt
    for (let i = this.equations.length - 1; i >= 0; i--) {
      const row = this.equations[i]
      if (row) {
        row.multiplier = read(this.rows, i * ROW_WIDTH + LAMBDA) * inverseDt
      }
    }
  }

  private solveCached(dt: number, world: World): number {
    if (this.equations.length === 0) {
      return 0
    }
    this.prepare(dt, world)
    const native = this.kernel?.run({
      count: this.equations.length,
      iterations: this.iterations,
      tolerance: this.tolerance,
      rows: this.rows,
      indices: this.indices,
      velocities: this.velocities,
      masses: this.masses,
      finite: this.finite,
    })
    const iterations = native ? native.iterations : this.iterate(this.equations.length)
    if (native) {
      this.zeroDeltas = native.zeros
      this.stats.backend = 'wasm'
      this.stats.nativeCalls++
    }
    this.stats.kernelBytes = this.kernel?.bytes ?? 0
    this.commit(world.bodies, dt)
    return iterations
  }

  dispose(): void {
    this.kernel?.dispose()
    this.kernel = null
    this.rows = new Float64Array(0)
    this.indices = new Int32Array(0)
    this.finite = new Uint8Array(0)
    this.velocities = new Float64Array(0)
    this.masses = new Float64Array(0)
    this.responders = new Int32Array(0)
    this.zeros = new Int32Array(0)
    this.stats.kernelBytes = 0
    this.stats.backend = 'javascript'
    this.stats.primed = false
  }
}
