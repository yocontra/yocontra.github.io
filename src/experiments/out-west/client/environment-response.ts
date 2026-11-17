/** Native render owners follow durable state; only fresh accepted events create fragments. */
import type { Entity, Material } from 'playcanvas'
import { ENVIRONMENT_PROPS } from '../content/environment-props.ts'
import { DYNAMIC_ASSETS } from '../content/manifest.ts'
import type { World } from '../ffa/sim/state.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { CollisionData } from '../runtime/protocol.ts'
import type { GameApplication } from './application.ts'
import { BarrelDebris } from './barrel-debris.ts'
import { NativeRagdolls } from './ragdolls.ts'
import type { BreakableWindows } from './windows.ts'

export function barrelFragmentUrl(): string {
  const source = Object.entries(DYNAMIC_ASSETS).find(([name]) => name === 'barrel-fragments')?.[1]
  if (!source) {
    throw new Error('Rebuild barrel fragments before starting Perdition')
  }
  return source.url
}
export class BreakableProps {
  readonly ready: Promise<void>
  private readonly roots: Entity[]
  private readonly materials: Material[]
  private readonly broken = new Set<number>()
  private readonly bursts = new Set<number>()
  private readonly debris: BarrelDebris
  private world: Pick<World, 'props' | 'tick' | 'seed'> | undefined
  private seed: number | undefined
  private lastTick = -1
  private initialTick: number | undefined
  private readonly initialBroken = new Set<number>()
  private closed = false
  constructor(
    game: GameApplication,
    town: Entity,
    ragdolls: NativeRagdolls,
    fragments = barrelFragmentUrl(),
  ) {
    this.roots = ENVIRONMENT_PROPS.map((prop) => {
      const roots = town.find((node) => node.name === prop.root)
      if (roots.length !== 1) {
        throw new Error(`Missing unique authored barrel ${prop.id}`)
      }
      return roots[0] as Entity
    })
    this.materials = this.roots.map((root) => {
      const material = root.findComponents('render')[0]?.meshInstances[0]?.material
      if (!material) {
        throw new Error('Missing native barrel PBR')
      }
      return material
    })
    this.debris = new BarrelDebris(game, ragdolls, fragments)
    this.ready = this.debris.ready
  }
  update(world: Pick<World, 'props' | 'tick' | 'seed'> | undefined): void {
    if (!world || this.closed) {
      return
    }
    const reset = this.world !== world || (this.seed !== world.seed && world.tick < this.lastTick)
    if (reset) {
      this.world = world
      this.seed = world.seed
      this.initialTick = world.tick
      this.broken.clear()
      this.bursts.clear()
      this.initialBroken.clear()
      world.props.forEach((value, index) => {
        if (value === 0) {
          this.initialBroken.add(index)
        }
      })
      this.debris.reset(world.props)
    }
    if (!reset && world.tick < this.lastTick) {
      return
    }
    this.lastTick = world.tick
    const health = world.props
    for (const [index, root] of this.roots.entries()) {
      if (health[index] === 0) {
        this.broken.add(index)
      }
      root.enabled = !this.broken.has(index)
    }
    this.debris.sync(new Uint8Array(ENVIRONMENT_PROPS.map((_, i) => (this.broken.has(i) ? 0 : 1))))
  }
  event(event: SimEvent): boolean {
    if (
      this.closed ||
      event.type !== 'prop_break' ||
      event.seed !== this.seed ||
      this.bursts.has(event.prop)
    ) {
      return false
    }
    if (this.initialBroken.has(event.prop) && event.tick <= (this.initialTick ?? -1)) {
      return false
    }
    const material = this.materials[event.prop]
    if (
      !(
        material &&
        Number.isInteger(event.prop) &&
        [
          event.point.x,
          event.point.y,
          event.point.z,
          event.impulse.x,
          event.impulse.y,
          event.impulse.z,
        ].every(Number.isFinite)
      )
    ) {
      return false
    }
    this.bursts.add(event.prop)
    this.broken.add(event.prop)
    for (const [index, root] of this.roots.entries()) {
      root.enabled = !this.broken.has(index)
    }
    this.debris.sync(new Uint8Array(ENVIRONMENT_PROPS.map((_, i) => (this.broken.has(i) ? 0 : 1))))
    this.debris.event(event, material)
    return true
  }
  stats() {
    return { broken: this.broken.size, ...this.debris.stats() }
  }
  destroy(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.debris.destroy()
  }
}

/** One async scene owner; cancellation can happen while the native fragment lease is loading. */
export async function prepareProps(
  game: GameApplication,
  town: Entity,
  {
    windows,
    collision,
    signal,
  }: { windows: BreakableWindows; collision: CollisionData; signal: AbortSignal },
) {
  const ragdolls = await NativeRagdolls.create(game, collision)
  if (signal.aborted) {
    ragdolls.destroy()
    return
  }
  let props: BreakableProps | undefined
  const cancel = () => {
    props?.destroy()
    ragdolls.destroy()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    windows.shatterInto(game, ragdolls)
    props = new BreakableProps(game, town, ragdolls)
    await props.ready
    return signal.aborted ? undefined : { ragdolls, props }
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
