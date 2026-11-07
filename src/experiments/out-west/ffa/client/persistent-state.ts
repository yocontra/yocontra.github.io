/** Authoritative presentation state survives asset loading; live events only update this cache. */
import {
  BAG_STYLES,
  EV_BAG_DROP,
  EV_BAG_GONE,
  EV_CALLOUT,
  EV_DYNAMITE_THROWN,
  EV_EXPLOSION,
  EV_GLASS_BREAK,
  EV_PICKUP_READY,
  EV_PICKUP_TAKEN,
  EV_SHOWDOWN_CALL,
  EV_SHOWDOWN_END,
  EV_SHOWDOWN_START,
  NONE,
  POS_SCALE,
  type TownPersistentState,
} from '../../contract/town.ts'
import type { WireEvent } from '../sim/codec-events.ts'
import {
  BAG_EXCLUSIVE_TICKS,
  BAG_EXPIRE_TICKS,
  CALLOUT_ACCEPT_TICKS,
  DYNAMITE_FUSE_TICKS,
  MAX_PLAYERS,
} from '../sim/constants.ts'
import type { Grid } from '../sim/layout.ts'

type BagState = TownPersistentState['bags'][number]
type ShowdownState = TownPersistentState['showdowns'][number]
type FuseState = TownPersistentState['fuses'][number]
type CalloutState = TownPersistentState['callouts'][number]

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const between = (value: unknown, lo: number, hi: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi
const integer = (value: unknown, lo = 0, hi = Number.MAX_SAFE_INTEGER): value is number =>
  between(value, lo, hi) && Number.isSafeInteger(value)
const player = (value: unknown): value is number => integer(value, 0, MAX_PLAYERS - 1)

function listOf<T>(
  value: unknown,
  limit: number,
  valid: (item: unknown) => item is T,
): value is T[] {
  return Array.isArray(value) && value.length <= limit && value.every(valid)
}

const unique = <T>(values: readonly T[], key: (value: T) => number | string): boolean =>
  new Set(values.map(key)).size === values.length
const fuseKey = (fuse: FuseState): string =>
  `${fuse.player}/${fuse.explodeAt}/${Math.round(fuse.x * POS_SCALE)}/${Math.round(fuse.z * POS_SCALE)}`

function validBag(value: unknown, tick: number, size: number): value is BagState {
  return (
    record(value) &&
    integer(value.id, 1, 65_535) &&
    between(value.x, 0, size) &&
    between(value.z, 0, size) &&
    integer(value.amount, 1) &&
    integer(value.style, 0, BAG_STYLES.length - 1) &&
    (player(value.exclusiveFor) || value.exclusiveFor === NONE) &&
    integer(value.exclusiveUntil, 0, tick + BAG_EXCLUSIVE_TICKS) &&
    integer(value.expiresAt, tick + 1, tick + BAG_EXPIRE_TICKS)
  )
}

function validShowdown(value: unknown, tick: number, size: number): value is ShowdownState {
  return (
    record(value) &&
    integer(value.id, 1, 65_535) &&
    player(value.a) &&
    player(value.b) &&
    value.a !== value.b &&
    between(value.cx, 0, size) &&
    between(value.cz, 0, size) &&
    (value.calledTick === null || integer(value.calledTick, 0, tick))
  )
}

function validFuse(value: unknown, tick: number, size: number): value is FuseState {
  return (
    record(value) &&
    player(value.player) &&
    between(value.x, 0, size) &&
    between(value.z, 0, size) &&
    integer(value.explodeAt, tick + 1, tick + DYNAMITE_FUSE_TICKS)
  )
}

function validCallout(value: unknown, tick: number): value is CalloutState {
  return (
    record(value) &&
    player(value.challenger) &&
    player(value.target) &&
    value.challenger !== value.target &&
    integer(value.untilTick, tick, tick + CALLOUT_ACCEPT_TICKS)
  )
}

/** Validate domain limits and unique identities; never truncate a supposedly complete state. */
export function validPersistentState(
  value: unknown,
  grid: Grid,
  pickupCount: number,
): value is TownPersistentState {
  if (!(record(value) && integer(value.tick))) {
    return false
  }
  const tick = value.tick
  return (
    listOf(value.bags, 65_535, (bag): bag is BagState => validBag(bag, tick, grid.size)) &&
    unique(value.bags, (bag) => bag.id) &&
    listOf(value.unavailablePickups, pickupCount, (spot): spot is number =>
      integer(spot, 0, pickupCount - 1),
    ) &&
    unique(value.unavailablePickups, (spot) => spot) &&
    listOf(value.brokenWindows, grid.glass.length, (pane): pane is number =>
      integer(pane, 0, grid.glass.length - 1),
    ) &&
    unique(value.brokenWindows, (pane) => pane) &&
    listOf(value.callouts, MAX_PLAYERS, (callout): callout is CalloutState =>
      validCallout(callout, tick),
    ) &&
    unique(value.callouts, (callout) => callout.target) &&
    listOf(value.showdowns, MAX_PLAYERS / 2, (showdown): showdown is ShowdownState =>
      validShowdown(showdown, tick, grid.size),
    ) &&
    unique(value.showdowns, (showdown) => showdown.id) &&
    unique(
      value.showdowns.flatMap((showdown) => [showdown.a, showdown.b]),
      (id) => id,
    ) &&
    listOf(value.fuses, MAX_PLAYERS + pickupCount, (fuse): fuse is FuseState =>
      validFuse(fuse, tick, grid.size),
    ) &&
    unique(value.fuses, fuseKey)
  )
}

export class PersistentTownState {
  readonly bags = new Map<number, BagState>()
  readonly unavailablePickups = new Set<number>()
  readonly brokenWindows = new Set<number>()
  readonly callouts = new Map<number, CalloutState>()
  readonly showdowns = new Map<number, ShowdownState>()
  readonly fuses = new Map<string, FuseState>()
  private readonly exploded = new Set<string>()
  tick = 0
  ready = false

  replace(state: TownPersistentState): void {
    this.bags.clear()
    this.unavailablePickups.clear()
    this.brokenWindows.clear()
    this.callouts.clear()
    this.showdowns.clear()
    this.fuses.clear()
    this.advance(state.tick)
    for (const bag of state.bags) {
      this.bags.set(bag.id, { ...bag })
    }
    for (const spot of state.unavailablePickups) {
      this.unavailablePickups.add(spot)
    }
    for (const pane of state.brokenWindows) {
      this.brokenWindows.add(pane)
    }
    for (const callout of state.callouts) {
      this.callouts.set(callout.target, { ...callout })
    }
    for (const showdown of state.showdowns) {
      this.showdowns.set(showdown.id, { ...showdown })
    }
    for (const fuse of state.fuses) {
      this.fuses.set(fuseKey(fuse), { ...fuse })
    }
    this.ready = true
  }

  advance(tick: number): void {
    if (tick !== this.tick) {
      this.exploded.clear()
    }
    this.tick = tick
    for (const [target, callout] of this.callouts) {
      if (callout.untilTick < tick) {
        this.callouts.delete(target)
      }
    }
  }

  private removeCallouts(a: number, b: number): void {
    for (const [target, callout] of this.callouts) {
      if (callout.challenger === a || callout.challenger === b || target === a || target === b) {
        this.callouts.delete(target)
      }
    }
  }

  /** False means a repeated persistent transition: its transient presentation must not replay. */
  event(event: WireEvent, tick: number): boolean {
    if (tick !== this.tick) {
      this.advance(tick)
    }
    switch (event.type) {
      case EV_CALLOUT: {
        const untilTick = tick + CALLOUT_ACCEPT_TICKS
        const have = this.callouts.get(event.target)
        if (have?.challenger === event.challenger && have.untilTick === untilTick) {
          return false
        }
        this.callouts.set(event.target, {
          challenger: event.challenger,
          target: event.target,
          untilTick,
        })
        return true
      }
      case EV_BAG_DROP:
        if (this.bags.has(event.bagId)) {
          return false
        }
        this.bags.set(event.bagId, {
          id: event.bagId,
          x: event.x / POS_SCALE,
          z: event.z / POS_SCALE,
          amount: event.amount,
          style: event.style,
          exclusiveFor: event.exclusiveFor,
          exclusiveUntil: event.exclusiveFor === NONE ? 0 : tick + BAG_EXCLUSIVE_TICKS,
          expiresAt: tick + BAG_EXPIRE_TICKS,
        })
        return true
      case EV_BAG_GONE:
        return this.bags.delete(event.bagId)
      case EV_PICKUP_TAKEN: {
        const fresh = !this.unavailablePickups.has(event.spot)
        this.unavailablePickups.add(event.spot)
        return fresh
      }
      case EV_PICKUP_READY:
        return this.unavailablePickups.delete(event.spot)
      case EV_GLASS_BREAK: {
        const fresh = !this.brokenWindows.has(event.window)
        this.brokenWindows.add(event.window)
        return fresh
      }
      case EV_SHOWDOWN_START:
        if (this.showdowns.has(event.id)) {
          return false
        }
        this.removeCallouts(event.a, event.b)
        this.showdowns.set(event.id, {
          id: event.id,
          a: event.a,
          b: event.b,
          cx: event.cx / POS_SCALE,
          cz: event.cz / POS_SCALE,
          calledTick: null,
        })
        return true
      case EV_SHOWDOWN_CALL: {
        const showdown = this.showdowns.get(event.id)
        if (showdown?.calledTick !== null) {
          return false
        }
        showdown.calledTick = tick
        return true
      }
      case EV_SHOWDOWN_END:
        return this.showdowns.delete(event.id)
      case EV_DYNAMITE_THROWN: {
        const fuse = {
          player: event.player,
          x: event.x / POS_SCALE,
          z: event.z / POS_SCALE,
          explodeAt: tick + event.fuseTicks,
        }
        const key = fuseKey(fuse)
        if (this.fuses.has(key)) {
          return false
        }
        this.fuses.set(key, fuse)
        return true
      }
      case EV_EXPLOSION: {
        const explosion = `${event.by}/${event.x}/${event.z}`
        if (this.exploded.has(explosion)) {
          return false
        }
        this.exploded.add(explosion)
        for (const [key, fuse] of this.fuses) {
          if (
            fuse.player === event.by &&
            Math.abs(fuse.x - event.x / POS_SCALE) < 0.01 &&
            Math.abs(fuse.z - event.z / POS_SCALE) < 0.01
          ) {
            this.fuses.delete(key)
            break
          }
        }
        return true
      }
      default:
        return true
    }
  }
}
