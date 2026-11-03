/**
 * TEMPORARY LOCAL STUB of stream B's pure `api/src/duel/judge-pvp.ts`, with the exact exported
 * signature B sent. Delete this file and import `judgePvp` from `../duel/judge-pvp.ts` once B merges.
 * The logic follows spec §2.2 closely enough for showdowns to work end to end.
 */
import type { RttStats } from '../judge.ts'

export interface PvpLink extends RttStats {
  tcp: number | null
}
export interface FixedDraw {
  ms: number | null
}
export interface PvpJudgeInput {
  callSentAt: readonly [number, number]
  shotSeenAt: readonly [number | null, number | null]
  localMs: readonly [number | null, number | null]
  rtt: readonly [PvpLink, PvpLink]
  now: number
  fixed?: readonly [FixedDraw | undefined, FixedDraw | undefined]
}
type Ms = [number | null, number | null]
export type PvpVerdict =
  | { kind: 'pending'; recheckAt: number }
  | { kind: 'win'; winner: 0 | 1; ms: Ms }
  | { kind: 'dead_heat'; ms: Ms }
  | { kind: 'froze'; ms: Ms }
  | { kind: 'coward'; who: 0 | 1; ms: Ms }

export const TIE_MS = 5
export const JUDGE_TIMEOUT_MS = 1500
const BASE_TOL = 20
const MAX_TOL = 60
const COWARD_MS = 100

export const rttFor = (l: PvpLink): number => Math.min(l.median, (l.tcp ?? l.median) + 40)
export const tolFor = (l: PvpLink): number => Math.min(MAX_TOL, BASE_TOL + 2 * l.jitter)

function reaction(input: PvpJudgeInput, i: 0 | 1): number | null {
  const fixed = input.fixed?.[i]
  if (fixed) {
    return fixed.ms
  }
  const seen = input.shotSeenAt[i]
  if (seen === null || seen === undefined) {
    return null
  }
  const link = input.rtt[i]
  const observed = seen - input.callSentAt[i] - rttFor(link) - tolFor(link)
  const local = input.localMs[i] ?? null
  return local === null ? -1 : Math.max(local, observed)
}

export function judgePvp(input: PvpJudgeInput): PvpVerdict {
  const ms: Ms = [reaction(input, 0), reaction(input, 1)]
  for (const i of [0, 1] as const) {
    const r = ms[i]
    if (r !== null && r < COWARD_MS) {
      return { kind: 'coward', who: i, ms }
    }
  }
  const [a, b] = ms
  if (a !== null && b !== null) {
    if (Math.abs(a - b) <= TIE_MS) {
      return { kind: 'dead_heat', ms }
    }
    return { kind: 'win', winner: a < b ? 0 : 1, ms }
  }
  const elapsed = (i: 0 | 1): number =>
    input.now - input.callSentAt[i] - rttFor(input.rtt[i]) - tolFor(input.rtt[i])
  if (a !== null && elapsed(1) > a + TIE_MS) {
    return { kind: 'win', winner: 0, ms }
  }
  if (b !== null && elapsed(0) > b + TIE_MS) {
    return { kind: 'win', winner: 1, ms }
  }
  if (input.now - Math.max(...input.callSentAt) > JUDGE_TIMEOUT_MS) {
    if (a === null && b === null) {
      return { kind: 'froze', ms }
    }
    return { kind: 'win', winner: a === null ? 1 : 0, ms }
  }
  return { kind: 'pending', recheckAt: input.now + 10 }
}
