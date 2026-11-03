/**
 * Judging two humans (or a human and a ghost). Pure: no Worker APIs, no clocks; the caller passes
 * `now`. Shared by the DuelRoom and Frontier's Call Out showdowns.
 *
 * Each human's reaction is recovered from what the server saw, minus a round trip:
 *
 *   rttFor(p) = min(appRtt.median, tcpRtt + 40)     (Cloudflare's transport RTT caps pong games)
 *   tolFor(p) = min(60, 20 + 2·jitter)               (base tolerance only if the RTT was capped)
 *   R[p]      = max(localMs, (shotSeenAt − callSentAt[p]) − rttFor(p) − tolFor(p))
 *
 * A client that lies about `localMs` is clamped to the server's floor. A client that delays its
 * pongs inflates `appRtt`, but the TCP cap bounds it, and a capped link loses its jitter slack too.
 * A client that delays its shot message to wait and see gains nothing: the floor rises with every
 * millisecond it waits, and it can never see the other shot before the result anyway.
 *
 * Resolution waits until the slower player can no longer win: with shot p in at R[p], q loses once
 * `now − callSentAt[q] − rttFor(q) − tolFor(q) > R[p] + TIE_MS`, because even an instant
 * `localMs` could not then bring q's floor within a tie of p.
 */
import { MIN_REACTION_MS, type RttStats } from '../judge.ts'

export const PVP_BASE_TOL = 20
export const PVP_MAX_TOL = 60
export const TIE_MS = 5
export const JUDGE_TIMEOUT_MS = 1500
/** Slack allowed above Cloudflare's TCP/QUIC RTT for the app-level round trip. */
export const TCP_RTT_SLACK_MS = 40
/** Above either of these, a player is offered ghosts only. */
export const MAX_PVP_RTT_MS = 250
export const MAX_PVP_JITTER_MS = 50

export type Seat = 0 | 1
export type Pair<T> = readonly [T, T]

/** One player's link: the app-level ping statistics plus Cloudflare's transport RTT at upgrade. */
export interface PvpLink extends RttStats {
  /** `request.cf.clientTcpRtt` (or `clientQuicRtt`) at the WebSocket upgrade; null if unknown. */
  tcp: number | null
}

/** A side whose reaction is already known at the call (a ghost or an outlaw). */
export interface FixedDraw {
  /** Judged reaction in ms after the call, or null if it freezes. */
  ms: number | null
}

export interface PvpJudgeInput {
  /** When the call went out on each seat's socket (epoch ms). */
  callSentAt: Pair<number>
  /** When each seat's first shot arrived, or null. */
  shotSeenAt: Pair<number | null>
  /** Each seat's own measurement from receiving the call; null means "pressed before the call". */
  localMs: Pair<number | null>
  rtt: Pair<PvpLink>
  now: number
  /** Seats driven by a ghost or outlaw: their reaction is fixed and they never send a shot. */
  fixed?: Pair<FixedDraw | undefined>
}

export type Reactions = [number | null, number | null]

export type PvpVerdict =
  /** Not decided yet. Call again at `recheckAt` (or on the next shot, whichever comes first). */
  | { kind: 'pending'; recheckAt: number }
  | { kind: 'win'; winner: Seat; ms: Reactions }
  | { kind: 'dead_heat'; ms: Reactions }
  | { kind: 'froze'; ms: Reactions }
  | { kind: 'coward'; who: Seat; ms: Reactions }

/** True if the app RTT had to be capped by the transport RTT (suspicious or just a bad link). */
export function rttCapped(link: PvpLink): boolean {
  return link.tcp !== null && link.median > link.tcp + TCP_RTT_SLACK_MS
}

export function rttFor(link: PvpLink): number {
  const median = Math.max(0, link.median)
  return link.tcp === null ? median : Math.min(median, Math.max(0, link.tcp) + TCP_RTT_SLACK_MS)
}

export function tolFor(link: PvpLink): number {
  if (rttCapped(link)) {
    return PVP_BASE_TOL
  }
  return Math.min(PVP_MAX_TOL, PVP_BASE_TOL + 2 * Math.max(0, link.jitter))
}

/** True if this link is good enough for a human duel. */
export function linkOkForPvp(link: PvpLink): boolean {
  return rttFor(link) <= MAX_PVP_RTT_MS && link.jitter <= MAX_PVP_JITTER_MS
}

/**
 * The judged reaction for one human shot. Returns null for "pressed before the call" (a null
 * `localMs`, or a shot that arrived before the call went out).
 */
export function pvpReaction(
  callSentAt: number,
  shotSeenAt: number,
  localMs: number | null,
  link: PvpLink,
): number | null {
  const observed = shotSeenAt - callSentAt
  if (observed < 0 || localMs === null || !Number.isFinite(localMs) || localMs < 0) {
    return null
  }
  const floor = observed - rttFor(link) - tolFor(link)
  // A client claiming to be slower than the server saw can only hurt itself; cap it at `observed`.
  return Math.max(Math.min(localMs, observed), floor)
}

/** The fastest reaction seat q could still be judged at if its shot arrived at `now`. */
function bestPossible(input: PvpJudgeInput, q: Seat): number {
  const link = input.rtt[q]
  return input.now - input.callSentAt[q] - rttFor(link) - tolFor(link)
}

/** The moment seat q's best possible reaction passes `ms`. */
function passesAt(input: PvpJudgeInput, q: Seat, ms: number): number {
  const link = input.rtt[q]
  return input.callSentAt[q] + rttFor(link) + tolFor(link) + ms
}

type SeatState =
  | { kind: 'coward' }
  | { kind: 'shot'; ms: number }
  | { kind: 'froze' }
  | { kind: 'open' }

function seatState(input: PvpJudgeInput, seat: Seat): SeatState {
  const fixed = input.fixed?.[seat]
  if (fixed) {
    if (fixed.ms === null || fixed.ms > JUDGE_TIMEOUT_MS) {
      return { kind: 'froze' }
    }
    return { kind: 'shot', ms: fixed.ms }
  }
  const seen = input.shotSeenAt[seat]
  if (seen === null) {
    return bestPossible(input, seat) > JUDGE_TIMEOUT_MS ? { kind: 'froze' } : { kind: 'open' }
  }
  const ms = pvpReaction(input.callSentAt[seat], seen, input.localMs[seat], input.rtt[seat])
  if (ms === null || ms < MIN_REACTION_MS) {
    return { kind: 'coward' }
  }
  return ms > JUDGE_TIMEOUT_MS ? { kind: 'froze' } : { kind: 'shot', ms }
}

const msOf = (s: SeatState): number | null => (s.kind === 'shot' ? Math.round(s.ms) : null)

function cowardVerdict(input: PvpJudgeInput, states: Pair<SeatState>, ms: Reactions): PvpVerdict {
  const [a, b] = states
  if (a.kind === 'coward' && b.kind === 'coward') {
    // Both drew early: the first to arrive is the coward.
    const seenA = input.shotSeenAt[0] ?? Number.POSITIVE_INFINITY
    const seenB = input.shotSeenAt[1] ?? Number.POSITIVE_INFINITY
    return { kind: 'coward', who: seenB < seenA ? 1 : 0, ms }
  }
  return { kind: 'coward', who: a.kind === 'coward' ? 0 : 1, ms }
}

/** Seat p has fired; decide against q, who has not (frozen or still open). */
function oneShot(input: PvpJudgeInput, states: Pair<SeatState>, ms: Reactions): PvpVerdict | null {
  for (const p of [0, 1] as const) {
    const q: Seat = p === 0 ? 1 : 0
    const mine = states[p]
    const theirs = states[q]
    if (mine.kind !== 'shot') {
      continue
    }
    if (theirs.kind === 'froze' || bestPossible(input, q) > mine.ms + TIE_MS) {
      return { kind: 'win', winner: p, ms }
    }
    if (theirs.kind === 'open') {
      return { kind: 'pending', recheckAt: Math.floor(passesAt(input, q, mine.ms + TIE_MS)) + 1 }
    }
  }
  return null
}

/** Decide the draw, or say when to look again. */
export function judgePvp(input: PvpJudgeInput): PvpVerdict {
  const states = [seatState(input, 0), seatState(input, 1)] as const
  const [a, b] = states
  const ms: Reactions = [msOf(a), msOf(b)]

  // Cowardice is decided the moment it is seen.
  if (a.kind === 'coward' || b.kind === 'coward') {
    return cowardVerdict(input, states, ms)
  }
  if (a.kind === 'shot' && b.kind === 'shot') {
    if (Math.abs(a.ms - b.ms) <= TIE_MS) {
      return { kind: 'dead_heat', ms }
    }
    return { kind: 'win', winner: a.ms < b.ms ? 0 : 1, ms }
  }
  if (a.kind === 'froze' && b.kind === 'froze') {
    return { kind: 'froze', ms }
  }
  const decided = oneShot(input, states, ms)
  if (decided) {
    return decided
  }
  // Nobody has fired yet (or one froze and the other is still open): wait for the timeout.
  const open = ([0, 1] as const).filter((s) => states[s].kind === 'open')
  const recheckAt = Math.min(...open.map((s) => passesAt(input, s, JUDGE_TIMEOUT_MS)))
  return { kind: 'pending', recheckAt: Math.floor(recheckAt) + 1 }
}
