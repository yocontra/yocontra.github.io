/**
 * What the contextual button (E / the 64 px touch button) does right now, and the light touch aim
 * assist (±6° magnetism within 14 m, spec §3.1). The server decides; this only picks which
 * button to send and what to call it.
 */
import {
  BOX_WAITING,
  BTN_CALLOUT,
  BTN_INTERACT,
  CHANNEL_NONE,
  EF_ALIVE,
  EF_PROTECTED,
  EF_SHOWDOWN,
  NONE,
  SELF_IN_SHOWDOWN,
} from '../../contract/town.ts'
import {
  CALLOUT_CONE_DEG,
  CALLOUT_MIN_CARRY,
  CALLOUT_RANGE,
  STRONGBOX_RADIUS,
} from '../sim/constants.ts'
import { type TownLayout, zoneAt } from '../sim/layout.ts'
import type { RemoteView } from './interp.ts'
import type { NetClient } from './net.ts'

export interface Action {
  bit: number
  /** Desktop prompt text. */
  prompt: string
  /** Touch button label. */
  label: string
  /** Touch: a line over the play area for actions that need explaining (banking), or null. */
  touchPrompt?: string | null
  /** The player it targets (call-outs), or NONE. */
  target: number
}

const ASSIST_RAD = (6 * Math.PI) / 180
const ASSIST_RANGE = 14

const money = (n: number) => `$${n.toLocaleString('en-US')}`

const angleDiff = (a: number, b: number): number => {
  const d = (((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  return d - Math.PI
}

export interface ContextInput {
  net: NetClient
  layout: TownLayout
  x: number
  z: number
  aim: number
  remotes: readonly RemoteView[]
  /** Challenger id if someone has called you out and the 3 s window is open. */
  calledBy: number
  nowS: number
}

export function currentAction(c: ContextInput): Action | null {
  const s = c.net.self
  if (!(s && c.net.alive) || (s.flags & SELF_IN_SHOWDOWN) !== 0) {
    return null
  }
  if (c.calledBy !== NONE) {
    const name = c.net.name(c.calledBy)
    return {
      bit: BTN_INTERACT,
      prompt: `E: accept ${name}'s call-out`,
      label: 'ACCEPT',
      target: c.calledBy,
    }
  }
  if (s.channelKind !== CHANNEL_NONE) {
    return null
  }
  const zone = zoneAt(c.layout, c.x, c.z)
  if (zone && s.carried > 0) {
    return zone.kind === 'bank'
      ? {
          bit: BTN_INTERACT,
          prompt: `Press E to bank ${money(s.carried)}, then hold still 2 s`,
          touchPrompt: 'Tap BANK, then hold still 2 s',
          label: 'BANK',
          target: NONE,
        }
      : {
          bit: BTN_INTERACT,
          prompt: `Press E to ship ${money(s.carried)} by stage, then hold still 4 s`,
          touchPrompt: 'Tap SHIP, then hold still 4 s',
          label: 'SHIP',
          target: NONE,
        }
  }
  const town = c.net.town
  const spot =
    town && town.strongboxState === BOX_WAITING
      ? c.layout.strongboxes[town.strongboxSpot]
      : undefined
  if (spot && Math.hypot(spot.x - c.x, spot.z - c.z) <= STRONGBOX_RADIUS) {
    return {
      bit: BTN_INTERACT,
      prompt: `E: crack the strongbox (${money(town?.strongboxValue ?? 0)}, 3 s)`,
      label: 'OPEN',
      target: NONE,
    }
  }
  if (s.carried >= CALLOUT_MIN_CARRY) {
    const t = calloutTarget(c)
    if (t) {
      const name = c.net.name(t.id)
      return { bit: BTN_CALLOUT, prompt: `Q: call out ${name}`, label: 'CALL OUT', target: t.id }
    }
  }
  return null
}

/** Mirrors the server's pick: the nearest eligible player inside the aim cone and 12 m. */
function calloutTarget(c: ContextInput): RemoteView | null {
  const cos = Math.cos((CALLOUT_CONE_DEG * Math.PI) / 180)
  const dx = Math.cos(c.aim)
  const dz = Math.sin(c.aim)
  let best: RemoteView | null = null
  let bestD = CALLOUT_RANGE
  for (const r of c.remotes) {
    if (!(r.flags & EF_ALIVE) || r.flags & EF_SHOWDOWN || r.carry * 20 < CALLOUT_MIN_CARRY) {
      continue
    }
    const ox = r.x - c.x
    const oz = r.z - c.z
    const d = Math.hypot(ox, oz)
    if (d > 0 && d < bestD && (ox * dx + oz * dz) / d >= cos) {
      best = r
      bestD = d
    }
  }
  return best
}

/** Snap the aim onto a target within ±6° and 14 m (touch and gamepad only). */
export function assistAim(
  x: number,
  z: number,
  aim: number,
  remotes: readonly RemoteView[],
): number {
  let best = aim
  let bestErr = ASSIST_RAD
  for (const r of remotes) {
    if (!(r.flags & EF_ALIVE) || r.flags & (EF_SHOWDOWN | EF_PROTECTED)) {
      continue
    }
    const ox = r.x - x
    const oz = r.z - z
    const d = Math.hypot(ox, oz)
    if (d < 0.5 || d > ASSIST_RANGE) {
      continue
    }
    const a = Math.atan2(oz, ox)
    const err = Math.abs(angleDiff(aim, a))
    if (err < bestErr) {
      bestErr = err
      best = a
    }
  }
  return best
}
