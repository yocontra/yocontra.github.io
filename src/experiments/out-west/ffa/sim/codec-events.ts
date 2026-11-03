/**
 * Snapshot events on the wire: a table of field layouts per event type (see `contract/town.ts`),
 * one generic writer and reader, and the mapping from sim events.
 */
import {
  EV_BAG_DROP,
  EV_BAG_GONE,
  EV_CALLOUT,
  EV_CHANNEL_CANCEL,
  EV_DAMAGE,
  EV_DEPOSIT,
  EV_HAT_OFF,
  EV_KILL,
  EV_LEFT,
  EV_RESPAWN,
  EV_SHOT,
  EV_SHOWDOWN_CALL,
  EV_SHOWDOWN_END,
  EV_SHOWDOWN_FAKE,
  EV_SHOWDOWN_START,
  EV_STRONGBOX_OPEN,
  EV_STRONGBOX_SPAWN,
  POS_SCALE,
} from '../../contract/town.ts'
import type { Reader, Writer } from './bytes.ts'
import type { SimEvent } from './types.ts'

/** Events on the wire. Field names match `SimEvent` where they overlap. */
export type WireEvent =
  | {
      type: typeof EV_SHOT
      shooter: number
      aim: number
      range: number
      target: number
      flags: number
    }
  | { type: typeof EV_DAMAGE; victim: number; attacker: number; amount: number; hp: number }
  | { type: typeof EV_KILL; victim: number; killer: number; flags: number; bounty: number }
  | {
      type: typeof EV_BAG_DROP
      bagId: number
      x: number
      z: number
      amount: number
      exclusiveFor: number
    }
  | { type: typeof EV_BAG_GONE; bagId: number; by: number }
  | { type: typeof EV_DEPOSIT; player: number; amount: number; commission: number }
  | { type: typeof EV_RESPAWN; player: number }
  | { type: typeof EV_STRONGBOX_SPAWN; spot: number; value: number }
  | { type: typeof EV_STRONGBOX_OPEN; spot: number; by: number; value: number }
  | { type: typeof EV_CALLOUT; challenger: number; target: number }
  | { type: typeof EV_SHOWDOWN_START; id: number; a: number; b: number; cx: number; cz: number }
  | { type: typeof EV_SHOWDOWN_FAKE; id: number; cue: number }
  | { type: typeof EV_SHOWDOWN_CALL; id: number }
  | { type: typeof EV_SHOWDOWN_END; id: number; winner: number; outcome: number; winnerMs: number }
  | { type: typeof EV_CHANNEL_CANCEL; player: number; kind: number }
  | { type: typeof EV_HAT_OFF; player: number }
  | { type: typeof EV_LEFT; player: number }

type Width = 1 | 2
type Layout = readonly (readonly [string, Width])[]

/** Field order and width per event type. Must match `EVENT_SIZES` in the contract. */
export const EVENT_LAYOUTS: Readonly<Record<number, Layout>> = {
  [EV_SHOT]: [
    ['shooter', 1],
    ['aim', 2],
    ['range', 1],
    ['target', 1],
    ['flags', 1],
  ],
  [EV_DAMAGE]: [
    ['victim', 1],
    ['attacker', 1],
    ['amount', 1],
    ['hp', 1],
  ],
  [EV_KILL]: [
    ['victim', 1],
    ['killer', 1],
    ['flags', 1],
    ['bounty', 2],
  ],
  [EV_BAG_DROP]: [
    ['bagId', 2],
    ['x', 2],
    ['z', 2],
    ['amount', 2],
    ['exclusiveFor', 1],
  ],
  [EV_BAG_GONE]: [
    ['bagId', 2],
    ['by', 1],
  ],
  [EV_DEPOSIT]: [
    ['player', 1],
    ['amount', 2],
    ['commission', 2],
  ],
  [EV_RESPAWN]: [['player', 1]],
  [EV_STRONGBOX_SPAWN]: [
    ['spot', 1],
    ['value', 2],
  ],
  [EV_STRONGBOX_OPEN]: [
    ['spot', 1],
    ['by', 1],
    ['value', 2],
  ],
  [EV_CALLOUT]: [
    ['challenger', 1],
    ['target', 1],
  ],
  [EV_SHOWDOWN_START]: [
    ['id', 2],
    ['a', 1],
    ['b', 1],
    ['cx', 2],
    ['cz', 2],
  ],
  [EV_SHOWDOWN_FAKE]: [
    ['id', 2],
    ['cue', 1],
  ],
  [EV_SHOWDOWN_CALL]: [['id', 2]],
  [EV_SHOWDOWN_END]: [
    ['id', 2],
    ['winner', 1],
    ['outcome', 1],
    ['winnerMs', 2],
  ],
  [EV_CHANNEL_CANCEL]: [
    ['player', 1],
    ['kind', 1],
  ],
  [EV_HAT_OFF]: [['player', 1]],
  [EV_LEFT]: [['player', 1]],
}

const clampWidth = (v: number, width: Width): number =>
  Math.max(0, Math.min(width === 1 ? 255 : 65_535, Math.round(v)))

export function writeEvent(w: Writer, ev: WireEvent): void {
  const layout = EVENT_LAYOUTS[ev.type]
  if (!layout) {
    return
  }
  const fields = ev as unknown as Record<string, number>
  w.u8(ev.type)
  for (const [name, width] of layout) {
    const v = clampWidth(fields[name] ?? 0, width)
    if (width === 1) {
      w.u8(v)
    } else {
      w.u16(v)
    }
  }
}

/** Reads one event; unknown types return null (and stop being parseable, so they end the list). */
export function readEvent(r: Reader): WireEvent | null {
  const type = r.u8()
  const layout = EVENT_LAYOUTS[type]
  if (!layout) {
    return null
  }
  const ev: Record<string, number> = { type }
  for (const [name, width] of layout) {
    ev[name] = width === 1 ? r.u8() : r.u16()
  }
  return ev as unknown as WireEvent
}

const q = (m: number): number => Math.round(m * POS_SCALE)

/** Map a sim event to its wire form. */
export function toWireEvent(ev: SimEvent): WireEvent {
  switch (ev.type) {
    case 'shot':
      return { ...ev, type: EV_SHOT }
    case 'damage':
      return { ...ev, type: EV_DAMAGE }
    case 'kill':
      return { ...ev, type: EV_KILL }
    case 'bag_drop':
      return {
        type: EV_BAG_DROP,
        bagId: ev.bag.id,
        x: q(ev.bag.x),
        z: q(ev.bag.z),
        amount: ev.bag.amount,
        exclusiveFor: ev.bag.exclusiveFor,
      }
    case 'bag_gone':
      return { ...ev, type: EV_BAG_GONE }
    case 'deposit':
      return { ...ev, type: EV_DEPOSIT }
    case 'respawn':
      return { ...ev, type: EV_RESPAWN }
    case 'strongbox_spawn':
      return { ...ev, type: EV_STRONGBOX_SPAWN }
    case 'strongbox_open':
      return { ...ev, type: EV_STRONGBOX_OPEN }
    case 'callout':
      return { ...ev, type: EV_CALLOUT }
    case 'showdown_start':
      return {
        type: EV_SHOWDOWN_START,
        id: ev.showdown.id,
        a: ev.showdown.a,
        b: ev.showdown.b,
        cx: q(ev.showdown.cx),
        cz: q(ev.showdown.cz),
      }
    case 'showdown_fake':
      return { ...ev, type: EV_SHOWDOWN_FAKE }
    case 'showdown_call':
      return { ...ev, type: EV_SHOWDOWN_CALL }
    case 'showdown_end':
      return { ...ev, type: EV_SHOWDOWN_END }
    case 'channel_cancel':
      return { ...ev, type: EV_CHANNEL_CANCEL }
    case 'hat_off':
      return { ...ev, type: EV_HAT_OFF }
    default:
      return { type: EV_LEFT, player: ev.player }
  }
}
