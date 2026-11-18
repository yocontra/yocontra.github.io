import { Entity, Quat, type RenderComponent, Vec3 } from 'playcanvas'
import { BUCKET_NODE_PREFIX } from '../content/metal-buckets.ts'
import type { World } from '../ffa/sim/state.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import { SIMULATION_HZ } from '../runtime/protocol.ts'

type BucketHit = Extract<SimEvent, { type: 'prop_rattle' }>
type Session = Pick<World, 'seed' | 'tick'>
interface Bucket {
  root: Entity
  rotation: Quat
  axis: Vec3
  staticRenders: { component: RenderComponent; group: number }[]
  tick: number
  start: number
  from: Quat
  strength: number
}

const SETTLE_SECONDS = 0.8

/** Transient native movement about the existing base. Cover never leaves the physics world. */
export class BucketResponse {
  private readonly buckets = new Map<number, Bucket>()
  private readonly active = new Set<Bucket>()
  private readonly tilt = new Quat()
  private world: Session | undefined
  private seed: number | undefined
  private firstTick = -1
  private closed = false as boolean

  constructor(town: Entity) {
    for (const node of town.find((candidate) => candidate.name.startsWith(BUCKET_NODE_PREFIX))) {
      if (!(node instanceof Entity)) {
        continue
      }
      const cover = Number(node.name.slice(BUCKET_NODE_PREFIX.length))
      this.buckets.set(cover, {
        root: node,
        rotation: node.getLocalRotation().clone(),
        axis: new Vec3(),
        staticRenders: node
          .findComponents('render')
          .filter((component) => component.batchGroupId >= 0)
          .map((component) => ({ component, group: component.batchGroupId })),
        tick: -1,
        start: 0,
        from: new Quat(),
        strength: 0,
      })
    }
  }

  private finish(bucket: Bucket): void {
    bucket.root.setLocalRotation(bucket.rotation)
    for (const { component, group } of bucket.staticRenders) {
      component.batchGroupId = group
    }
    this.active.delete(bucket)
  }

  update(world: Session, now = performance.now()): void {
    if (this.closed) {
      return
    }
    if (this.world !== world || this.seed !== world.seed) {
      for (const bucket of this.active) {
        this.finish(bucket)
      }
      for (const bucket of this.buckets.values()) {
        bucket.tick = -1
      }
      this.world = world
      this.seed = world.seed
      this.firstTick = world.tick
    }
    for (const bucket of this.active) {
      const elapsed = Math.max(0, (now - bucket.start) / 1000)
      if (elapsed === 0) {
        continue
      }
      if (elapsed >= SETTLE_SECONDS) {
        this.finish(bucket)
        continue
      }
      const tail = 1 - elapsed / SETTLE_SECONDS
      const angle = Math.sin(elapsed * Math.PI * 6.6) * tail ** 2 * bucket.strength * 15
      this.tilt.setFromAxisAngle(bucket.axis, angle).mul(bucket.rotation)
      bucket.root.setLocalRotation(
        this.tilt.slerp(bucket.from, this.tilt, Math.min(1, elapsed / 0.1)),
      )
    }
  }

  event(event: BucketHit, now = performance.now()): boolean {
    const bucket = this.buckets.get(event.cover)
    if (
      this.closed ||
      !bucket ||
      !this.world ||
      !Number.isInteger(event.tick) ||
      event.seed !== this.seed ||
      event.tick < this.firstTick ||
      event.tick + SETTLE_SECONDS * SIMULATION_HZ < this.world.tick ||
      event.tick <= bucket.tick ||
      !(event.strength > 0 && event.strength <= 1) ||
      ![event.dx, event.dz].every(Number.isFinite)
    ) {
      return false
    }
    bucket.axis.set(event.dz, 0, -event.dx)
    if (bucket.axis.lengthSq() < 1e-6) {
      return false
    }
    bucket.axis.normalize()
    bucket.tick = event.tick
    bucket.start = now
    bucket.from.copy(bucket.root.getLocalRotation())
    bucket.strength = event.strength
    for (const { component } of bucket.staticRenders) {
      component.batchGroupId = -1
    }
    this.active.add(bucket)
    return true
  }

  destroy(): void {
    this.closed = true
    for (const bucket of this.active) {
      this.finish(bucket)
    }
    this.buckets.clear()
  }
}
