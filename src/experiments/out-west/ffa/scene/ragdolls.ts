import type { Body, World } from 'cannon-es'
import { type Camera, type Object3D, Vector3 } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { RagdollImpact } from '../client/shot-impact.ts'
import type { Grid, TownLayout } from '../sim/layout.ts'
import { prepareCorpseLod } from './corpse-lod.ts'
import type { CorpseRig } from './crowd/corpse-rig.ts'
import { CorpseWarmup } from './crowd/corpse-warmup.ts'
import { CorpsePhysics } from './ragdoll-body.ts'
import { CorpseBroadphase } from './ragdoll-broadphase.ts'
import { corpseGround } from './ragdoll-cloth-contact.ts'
import { RAGDOLL_STEP as STEP } from './ragdoll-joints.ts'
import { CorpseShadows } from './ragdoll-shadows.ts'
import { CorpseSolver } from './ragdoll-solver.ts'
import { ragdollPanes, ragdollStatic } from './ragdoll-static.ts'
import { CorpsePresentation } from './ragdoll-view.ts'
import { createRagdollWorld } from './ragdoll-world.ts'

interface Position {
  x: number
  y?: number
  z: number
}
interface Source {
  captureCorpse: (id: number, at?: Position) => Promise<CorpseRig | null>
  suppressCorpse: (id: number, identity: string) => boolean
  releaseCorpse: (id: number) => void
}
interface Corpse {
  born: number
  tick: number
  physics: CorpsePhysics | null
  cancelled: boolean
  job: Promise<void> | null
  valid: (() => boolean) | undefined
}
const LIFETIME = 12
const CAPACITY = 32

export class Ragdolls {
  readonly world: World
  private readonly root: Object3D
  private readonly source: Source
  private readonly ground: ReturnType<typeof corpseGround>
  private readonly lifetime = new AbortController()
  private readonly corpses = new Map<number, Corpse>()
  private readonly panes: ReturnType<typeof ragdollPanes>
  private readonly broken = new Set<number>()
  private time = 0
  private steps = 0
  private physicsMs = 0
  private readonly timings = {
    initialization: 0,
    capture: 0,
    build: 0,
    step: 0,
    pose: 0,
    shadows: 0,
  }
  private readonly staticCount: number
  private shadows: CorpseShadows | null = null
  private timeStep = STEP
  private readonly warmup: CorpseWarmup
  private readonly presentation = new CorpsePresentation()
  private readonly active: CorpsePhysics[] = []

  constructor(options: {
    root: Object3D
    source: Source
    grid: Grid
    props: GLTF
    layout?: TownLayout
    solverModule?: WebAssembly.Module | null
  }) {
    const started = performance.now()
    this.root = options.root
    this.source = options.source
    this.world = createRagdollWorld(options.solverModule)
    this.warmup = new CorpseWarmup((id) => this.source.captureCorpse(id))
    this.ground = corpseGround(options.grid, options.layout, this.broken)
    for (const body of ragdollStatic(options.grid, options.props, options.layout)) {
      this.world.addBody(body)
    }
    this.panes = ragdollPanes(options.grid)
    for (const body of this.panes.values()) {
      this.world.addBody(body)
    }
    this.staticCount = this.world.bodies.length
    this.timings.initialization = performance.now() - started
  }

  async prepareCorpses(
    ids: Iterable<number>,
    compile: () => void,
    valid: () => boolean,
  ): Promise<void> {
    await this.warmup.prepare(
      ids,
      (roots) => {
        this.root.add(...roots)
        try {
          compile()
        } finally {
          for (const root of roots) {
            root.removeFromParent()
          }
        }
      },
      valid,
    )
  }

  /** The descriptor is captured synchronously before the caller starts the Death animation. */
  killed(
    id: number,
    at: Position,
    from: Position | null,
    motion: {
      velocity?: Vector3
      tick?: number
      impact?: RagdollImpact | null
      valid?: () => boolean
    } = {},
  ): Promise<void> {
    if (this.lifetime.signal.aborted || !Number.isInteger(id) || id < 0 || id >= CAPACITY) {
      return Promise.resolve()
    }
    const have = this.corpses.get(id)
    if (have) {
      return have.job ?? Promise.resolve()
    }
    if (![at.x, at.y ?? 0, at.z].every(Number.isFinite)) {
      return Promise.resolve()
    }
    const record: Corpse = {
      born: this.time,
      tick: motion.tick ?? 0,
      physics: null,
      cancelled: false,
      job: null,
      valid: motion.valid,
    }
    this.corpses.set(id, record)
    const impulse = from ? new Vector3(at.x - from.x, 0.1, at.z - from.z) : new Vector3()
    if (impulse.lengthSq() > 1e-8) {
      impulse.normalize().multiplyScalar(3)
    }
    // Calling capture before creating the continuation is essential: near bones and the far
    // VAT clip/frame belong to this life, even if dressing the clone needs an asynchronous load.
    const before = performance.now()
    let pending: Promise<CorpseRig | null>
    try {
      pending = this.source.captureCorpse(id, at)
    } catch (error: unknown) {
      record.cancelled = true
      console.error('Dressed ragdoll capture failed', error)
      return Promise.resolve()
    }
    this.timings.capture = performance.now() - before
    record.job = pending
      .then((rig) => {
        this.attach(id, record, rig, {
          velocity: motion.velocity?.clone() ?? rig?.velocity.clone() ?? new Vector3(),
          impulse,
          impact: motion.impact ?? null,
        })
        if (record.physics && rig?.lodSources) {
          // Optional index preparation never holds a falling physical body behind a worker.
          void prepareCorpseLod(rig)
        }
      })
      .catch((error: unknown) => {
        record.cancelled = true
        console.error('Dressed ragdoll capture failed', error)
      })
    return record.job
  }

  /** Asset loading and joins can reveal already-dead riders; restore only missing physics. */
  async recoverDead(
    players: readonly (Position & { id: number })[],
    tick: number,
    valid: (id: number) => boolean,
  ): Promise<void> {
    await Promise.all(
      players.slice(0, CAPACITY).map(async (player) => {
        if (this.lifetime.signal.aborted || !valid(player.id)) {
          return
        }
        const previous = this.corpses.get(player.id)
        await previous?.job
        if (this.lifetime.signal.aborted || !valid(player.id)) {
          return
        }
        const current = this.corpses.get(player.id)
        if (current && current !== previous) {
          await current.job
          return
        }
        if (current?.physics) {
          return
        }
        this.released(player.id)
        await this.killed(player.id, player, null, {
          tick,
          velocity: new Vector3(),
          valid: () => valid(player.id),
        })
      }),
    )
  }

  private attach(
    id: number,
    record: Corpse,
    rig: CorpseRig | null,
    motion: { velocity: Vector3; impulse: Vector3; impact: RagdollImpact | null },
  ): void {
    if (!rig) {
      record.cancelled = true
      return
    }
    if (
      this.lifetime.signal.aborted ||
      record.cancelled ||
      this.corpses.get(id) !== record ||
      (record.valid && !record.valid())
    ) {
      rig.dispose()
      return
    }
    let physics: CorpsePhysics
    const started = performance.now()
    try {
      physics = new CorpsePhysics(this.world, rig, { ...motion, step: this.timeStep }, this.ground)
    } catch (error: unknown) {
      record.cancelled = true
      rig.dispose()
      console.error('Dressed ragdoll physics failed', error)
      return
    }
    this.timings.build = performance.now() - started
    if (!this.source.suppressCorpse(id, rig.identity)) {
      record.cancelled = true
      physics.dispose()
      return
    }
    this.root.add(rig.root)
    record.physics = physics
    record.born = this.time
  }

  released(id: number): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    const corpse = this.corpses.get(id)
    if (corpse) {
      corpse.cancelled = true
      corpse.physics?.dispose()
      this.corpses.delete(id)
    }
    this.source.releaseCorpse(id)
  }

  /** Full snapshots can recover a respawn even when its transient event was capped. */
  reconcileAlive(ids: Iterable<number>, tick: number): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    for (const id of ids) {
      const record = this.corpses.get(id)
      if (record && record.tick < tick) {
        this.released(id)
      }
    }
  }

  get hasCorpses(): boolean {
    return this.corpses.size > 0
  }

  set contactShadows(enabled: boolean) {
    if (this.lifetime.signal.aborted) {
      return
    }
    if (enabled && !this.shadows) {
      this.shadows = new CorpseShadows(this.root, this.ground)
    }
    if (this.shadows) {
      this.shadows.mesh.visible = enabled
      if (!enabled) {
        this.shadows.mesh.count = 0
      }
    }
  }

  set frequency(hz: 60 | 120) {
    const step = 1 / hz
    if (this.lifetime.signal.aborted || (hz !== 60 && hz !== 120) || step === this.timeStep) {
      return
    }
    this.timeStep = step
    this.world.accumulator = 0
    for (const record of this.corpses.values()) {
      record.physics?.setStep(step)
    }
  }

  setBrokenWindows(indices: ReadonlySet<number>): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    for (const [index, body] of this.panes) {
      if (indices.has(index) && !this.broken.has(index)) {
        this.wakeAt(body)
        this.world.removeBody(body)
      } else if (!indices.has(index) && this.broken.has(index)) {
        this.world.addBody(body)
        this.wakeAt(body)
      }
    }
    this.broken.clear()
    for (const index of indices) {
      this.broken.add(index)
    }
  }

  breakWindow(index: number): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    const pane = this.panes.get(index)
    if (pane && !this.broken.has(index)) {
      this.wakeAt(pane)
      this.world.removeBody(pane)
      this.broken.add(index)
    }
  }

  private wakeAt(support: Body): void {
    if (support.aabbNeedsUpdate) {
      support.updateAABB()
    }
    const a = support.aabb
    for (const record of this.corpses.values()) {
      const parts = record.physics?.parts ?? []
      const touching = parts.some((part) => {
        const body = part.body
        if (body.aabbNeedsUpdate) {
          body.updateAABB()
        }
        const b = body.aabb
        return (
          b.upperBound.x >= a.lowerBound.x - 0.05 &&
          b.lowerBound.x <= a.upperBound.x + 0.05 &&
          b.upperBound.y >= a.lowerBound.y - 0.05 &&
          b.lowerBound.y <= a.upperBound.y + 0.05 &&
          b.upperBound.z >= a.lowerBound.z - 0.05 &&
          b.lowerBound.z <= a.upperBound.z + 0.05
        )
      })
      if (touching) {
        for (const part of parts) {
          part.body.wakeUp()
        }
      }
    }
  }

  update(dt: number): void {
    this.physicsMs = 0
    this.timings.step = 0
    this.timings.pose = 0
    this.timings.shadows = 0
    if (this.lifetime.signal.aborted || !Number.isFinite(dt) || dt <= 0) {
      return
    }
    this.time += Math.min(dt, 0.1)
    const active = this.active
    active.length = 0
    for (const record of this.corpses.values()) {
      if (this.time - record.born > LIFETIME) {
        record.cancelled = true
        record.physics?.dispose()
        record.physics = null
        // Keep this life suppressed: revealing its old animated body would teleport it back.
      } else if (record.physics) {
        active.push(record.physics)
      }
    }
    if (active.length === 0 || active.every((corpse) => corpse.sleeping)) {
      if (!this.presentation.ready) {
        this.updateShadows(active)
      }
      return
    }
    const before = performance.now()
    for (const corpse of active) {
      corpse.limitSpeed()
    }
    const stepAt = performance.now()
    this.world.step(this.timeStep, Math.min(dt, 1 / 15), Math.round(1 / 15 / this.timeStep))
    this.timings.step = performance.now() - stepAt
    const poseAt = performance.now()
    for (const corpse of active) {
      corpse.sync(true, this.presentation.ready ? this.presentation.view : undefined)
    }
    this.timings.pose = performance.now() - poseAt
    this.physicsMs = performance.now() - before
    if (!this.presentation.ready) {
      this.updateShadows(active)
    }
    this.steps++
  }

  present(camera: Camera, skipOffscreenPose: boolean): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    const started = performance.now()
    this.presentation.update(camera, skipOffscreenPose, this.active)
    const ms = performance.now() - started
    this.timings.pose += ms
    this.physicsMs += ms
    this.updateShadows(this.active)
  }

  private updateShadows(active: readonly CorpsePhysics[]): void {
    if (this.shadows) {
      const started = performance.now()
      this.shadows.update(active)
      this.timings.shadows = performance.now() - started
    }
  }

  focus(id: number, out: Vector3): Vector3 | null {
    if (this.lifetime.signal.aborted) {
      return null
    }
    const physics = this.corpses.get(id)?.physics
    return physics ? out.copy(physics.center()) : null
  }

  radius(id: number): number {
    return this.corpses.get(id)?.physics?.radius ?? 0
  }

  setVisible(id: number, visible: boolean): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    this.corpses.get(id)?.physics?.setVisible(visible)
  }

  clear(): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    this.warmup.invalidate()
    this.active.length = 0
    for (const id of [...this.corpses.keys()]) {
      this.released(id)
    }
    this.shadows?.update([])
  }

  get stats() {
    const active = [...this.corpses.values()].flatMap((corpse) =>
      corpse.physics ? [corpse.physics] : [],
    )
    return {
      corpses: active.length,
      pending: [...this.corpses.values()].filter((corpse) => !(corpse.physics || corpse.cancelled))
        .length,
      awake: active.filter((corpse) => !corpse.sleeping).length,
      bodies: active.reduce((sum, corpse) => sum + corpse.parts.length, 0),
      constraints: active.reduce((sum, corpse) => sum + corpse.constraints.length, 0),
      contacts: this.world.contacts.length,
      staticBodies: this.staticCount,
      warmModels: this.warmup.count,
      posed: active.filter((corpse) => corpse.poseActive).length,
      frequency: Math.round(1 / this.timeStep),
      contactShadows: this.shadows?.mesh.count ?? 0,
      steps: this.steps,
      physicsMs: this.physicsMs,
      timings: { ...this.timings },
      cannonLastSubstep: { ...this.world.profile },
      solver: this.world.solver instanceof CorpseSolver ? { ...this.world.solver.stats } : null,
      separation: Math.max(0, ...active.map((corpse) => corpse.separation)),
      broadphase:
        this.world.broadphase instanceof CorpseBroadphase ? this.world.broadphase.stats : null,
    }
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    this.clear()
    this.lifetime.abort()
    this.warmup.dispose()
    this.shadows?.dispose()
    this.shadows = null
    for (const body of [...this.world.bodies]) {
      this.world.removeBody(body)
    }
    if (this.world.broadphase instanceof CorpseBroadphase) {
      this.world.broadphase.dispose()
    }
    if (this.world.solver instanceof CorpseSolver) {
      this.world.solver.dispose()
    }
  }
}
