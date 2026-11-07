/** Static geometry never moves: hash it once, then sweep only the actual moving bodies. */
import { type AABB, Body, Broadphase, type World } from 'cannon-es'

interface Member {
  owner: object
  index: number
  parent: number
  region: number
}
const owners = new WeakMap<Body, Member>()
export const tagCorpseBody = (body: Body, member: Member): void => {
  owners.set(body, member)
}
const key = (x: number, z: number): number => (x << 16) ^ (z & 0xff_ff)
const TILE = 8

function sameRegion(a: Body, b: Body): boolean {
  const left = owners.get(a)
  const right = owners.get(b)
  if (!(left && right && left.owner === right.owner)) {
    return false
  }
  return (
    left.parent === right.index ||
    right.parent === left.index ||
    left.region === right.region ||
    ((left.region === 2 || left.region === 64) && (right.region === 2 || right.region === 64))
  )
}

export class CorpseBroadphase extends Broadphase {
  private readonly bins = new Map<number, Set<Body>>()
  private readonly registered = new Map<Body, number[]>()
  private readonly global = new Set<Body>()
  private readonly candidates = new Set<Body>()
  private readonly moving: Body[] = []
  readonly stats = { staticTests: 0, dynamicTests: 0, pairs: 0, bins: 0 }
  private readonly added = (event: { body: Body }) => this.register(event.body)
  private readonly removed = (event: { body: Body }) => this.unregister(event.body)

  constructor(world: World) {
    super()
    this.world = world
    this.useBoundingBoxes = true
    for (const body of world.bodies) {
      this.register(body)
    }
    world.addEventListener('addBody', this.added)
    world.addEventListener('removeBody', this.removed)
  }

  private register(body: Body): void {
    if (body.type !== Body.STATIC || this.registered.has(body)) {
      return
    }
    body.updateAABB()
    const a = body.aabb
    if (a.upperBound.x - a.lowerBound.x > 1024 || a.upperBound.z - a.lowerBound.z > 1024) {
      this.global.add(body)
      return
    }
    const keys: number[] = []
    CorpseBroadphase.cells(a, (cell) => {
      const bin = this.bins.get(cell) ?? new Set<Body>()
      bin.add(body)
      this.bins.set(cell, bin)
      keys.push(cell)
    })
    this.registered.set(body, keys)
  }

  private unregister(body: Body): void {
    this.global.delete(body)
    for (const cell of this.registered.get(body) ?? []) {
      const bin = this.bins.get(cell)
      bin?.delete(body)
      if (bin?.size === 0) {
        this.bins.delete(cell)
      }
    }
    this.registered.delete(body)
  }

  private static cells(a: AABB, visit: (cell: number) => void): void {
    for (let z = Math.floor(a.lowerBound.z / TILE); z <= Math.floor(a.upperBound.z / TILE); z++) {
      for (let x = Math.floor(a.lowerBound.x / TILE); x <= Math.floor(a.upperBound.x / TILE); x++) {
        visit(key(x, z))
      }
    }
  }

  private collideStatics(body: Body, pairsA: Body[], pairsB: Body[]): void {
    this.candidates.clear()
    for (const global of this.global) {
      this.candidates.add(global)
    }
    CorpseBroadphase.cells(body.aabb, (cell) => {
      for (const other of this.bins.get(cell) ?? []) {
        this.candidates.add(other)
      }
    })
    for (const other of this.candidates) {
      this.stats.staticTests++
      if (body.aabb.overlaps(other.aabb) && this.needBroadphaseCollision(body, other)) {
        pairsA.push(body)
        pairsB.push(other)
      }
    }
  }

  override collisionPairs(world: World, pairsA: Body[], pairsB: Body[]): void {
    this.stats.staticTests = 0
    this.stats.dynamicTests = 0
    this.moving.length = 0
    for (const body of world.bodies) {
      if (body.type === Body.STATIC) {
        continue
      }
      if (body.aabbNeedsUpdate) {
        body.updateAABB()
      }
      this.moving.push(body)
      this.collideStatics(body, pairsA, pairsB)
    }
    // The bound test precedes filtering, unlike Cannon0.20 SAP's quadratic static scan.
    this.moving.sort((a, b) => a.aabb.lowerBound.x - b.aabb.lowerBound.x)
    for (let i = 0; i < this.moving.length; i++) {
      const a = this.moving[i]
      if (!a) {
        continue
      }
      for (let j = i + 1; j < this.moving.length; j++) {
        const b = this.moving[j]
        if (!b || b.aabb.lowerBound.x > a.aabb.upperBound.x) {
          break
        }
        this.stats.dynamicTests++
        if (!sameRegion(a, b) && a.aabb.overlaps(b.aabb) && this.needBroadphaseCollision(a, b)) {
          pairsA.push(a)
          pairsB.push(b)
        }
      }
    }
    this.stats.pairs = pairsA.length
    this.stats.bins = this.bins.size
  }

  override aabbQuery(world: World, aabb: AABB, result: Body[] = []): Body[] {
    for (const body of world.bodies) {
      if (body.aabbNeedsUpdate) {
        body.updateAABB()
      }
      if (body.aabb.overlaps(aabb)) {
        result.push(body)
      }
    }
    return result
  }

  dispose(): void {
    this.world?.removeEventListener('addBody', this.added)
    this.world?.removeEventListener('removeBody', this.removed)
    this.bins.clear()
    this.registered.clear()
    this.global.clear()
    this.candidates.clear()
    this.moving.length = 0
  }
}
