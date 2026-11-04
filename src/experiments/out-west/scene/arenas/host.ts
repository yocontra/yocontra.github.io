/**
 * The world's arena slot: which arena is up, building the next from its lazily loaded module,
 * disposing the last (only one is ever resident), and moving everything shared onto it: the lamp
 * lights, the ground's light pools and ruts, the bell, and the town's life.
 */
import type { Group, PointLight, Scene, Vector3, Vector4 } from 'three'
import { LIFE, type LifeLayout } from '../townlife.ts'
import { arenaForSlot } from './acts.ts'
import { padPools } from './pools.ts'
import { ARENA_MODULES, forcedArena } from './registry.ts'
import type { Arena, ArenaCtx, ArenaId } from './types.ts'

/** What the world hands over: the things an arena swap moves. */
export interface ArenaSlots {
  readonly scene: Scene
  readonly root: Group
  /** The street's own group (hidden while another arena is up). */
  readonly town: Group
  readonly lanterns: readonly { light: PointLight; base: number }[]
  /** The street's lamp flames (x, y, z), for when it comes back. */
  readonly streetLamps: readonly (readonly [number, number, number])[]
  readonly streetPools: () => Vector4[]
  readonly pools: { owPools: { value: Vector4[] }; owRuts: { value: number } }
  /** The call's bell: moved to each arena's, back to `streetBell` with the street. */
  readonly bellPos: Vector3
  readonly streetBell: Vector3
  /** The shared materials, read when an arena is built (the atlas may land late). */
  readonly ctx: () => ArenaCtx
  /** How lit the lamps and windows are now (0 by day, 1 at night). */
  readonly nightK: () => number
}

export class ArenaHost {
  private arena: Arena | null = null
  /** The arena last asked for (one still loading is dropped if this moves on). */
  private want: ArenaId = 'street'
  private readonly forced = forcedArena()
  private readonly slots: ArenaSlots

  constructor(slots: ArenaSlots) {
    this.slots = slots
    if (this.forced) {
      this.set(this.forced)
    }
  }

  get id(): ArenaId {
    return this.arena?.id ?? 'street'
  }

  get life(): LifeLayout | null {
    return this.arena?.life ?? null
  }

  /** Outlaw `slot`'s act: its arena, and the next act's module fetched ahead. */
  stageSlot(slot: number): void {
    this.set(arenaForSlot(slot))
    const next = arenaForSlot(slot + 1)
    if (next !== 'street' && next !== this.want) {
      ARENA_MODULES[next]().catch(() => undefined)
    }
  }

  /** Show arena `id` (`#arena=` pins every request to one arena). */
  set(id: ArenaId): void {
    const want = this.forced ?? id
    if (want === this.want) {
      return
    }
    this.want = want
    if (want === 'street') {
      this.show(null)
      return
    }
    ARENA_MODULES[want]()
      .then((m) => {
        if (this.want === want) {
          this.show(m.build(this.slots.ctx()))
        }
      })
      .catch((e: unknown) => console.warn('[arena]', want, e))
  }

  /** The dusk came on (0..1). */
  night(k: number): void {
    this.arena?.night?.(k)
  }

  private show(next: Arena | null): void {
    const s = this.slots
    if (this.arena) {
      this.arena.root.removeFromParent()
      this.arena.dispose()
    }
    this.arena = next
    s.town.visible = next === null
    if (next) {
      s.root.add(next.root)
    }
    // the lights stay on the scene (a light count change recompiles every lit shader): an unused
    // one only goes dark
    const lamps = next ? next.lanterns : s.streetLamps
    s.lanterns.forEach((l, i) => {
      const at = lamps[i]
      l.base = at ? 20 : 0
      if (at) {
        l.light.position.set(at[0], at[1], at[2])
      }
    })
    s.pools.owPools.value = next ? padPools(next.pools) : s.streetPools()
    s.pools.owRuts.value = next ? next.ruts : 1
    s.bellPos.copy(next ? next.bell : s.streetBell)
    next?.night?.(s.nightK())
    LIFE.town?.arrange(next ? next.life : null)
    // the town light probe sees the new walls
    const ud = s.scene.userData
    ud.owLightVersion = ((ud.owLightVersion as number | undefined) ?? 0) + 1
  }
}
