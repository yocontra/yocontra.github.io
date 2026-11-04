/**
 * The solo meta-game's HTTP contract: medals and challenges, the guest purse migration and the
 * Daily Outlaw. Pure TypeScript shared by the browser and the Worker. Owned by the meta-game stream.
 *
 *   GET  /progress                    (Bearer)  → ProgressResponse
 *   POST /progress/migrate            (Bearer)  MigrateRequest → MigrateResponse
 *                                     Once per account; 409 { ok:false } after that (with the grant).
 *   POST /progress/claim              (Bearer)  ClaimRequest → ClaimResponse
 *                                     A hat-shot challenge, against a ranked win the server recorded
 *                                     on that outlaw in that run within 15 minutes.
 *   POST /progress/legend             (Bearer)  LegendRequest → ProgressResponse
 *                                     Legend cosmetics; needs a full ranked gauntlet clear.
 *   GET  /daily                       (Bearer optional) → DailyResponse (today's spec, your tries)
 *   POST /daily/sessions              { turnstileToken } (Bearer optional) → RankedSessionResponse
 *                                     201. 429 out of tries today, 503 over budget.
 *   GET  /daily/sessions/:id/ws       The duel: the ranked protocol (`contract/ranked.ts`), one duel.
 *   GET  /daily/board?day=YYYY-MM-DD  (Bearer optional) → DailyBoardResponse
 *
 * Medals, challenges and the solo cosmetics are booked by the ranked server from its own verdicts
 * (the credit job), never from these routes, except the claimed hat shots and the Legend pair.
 * Errors are `{ ok: false, error }`.
 */
import type { DailySpec } from '../data/daily.ts'
import type { GuestClaim, OutlawMark } from '../data/medals.ts'

/** The account's server-recorded medals and challenges, and what it earned with them. */
export interface ProgressResponse {
  /** One per outlaw, by gauntlet slot. */
  marks: OutlawMark[]
  /** Days with a Daily Outlaw win. */
  dailyWins: number
  /** The solo reward items this account owns. */
  rewards: string[]
  /** The guest purse migrated into this account, or null if it never has been. */
  migration: { xp: number; cash: number; at: number } | null
  storeLevel: number
}

export interface MigrateRequest {
  claim: GuestClaim
}

export interface MigrateResponse {
  ok: true
  /** What was granted (capped), and what the device claimed. */
  xp: number
  cash: number
  claimed: { xp: number; cash: number }
  purse: number
  level: number
}

export interface ClaimRequest {
  challengeId: string
  /** The ranked run (session id) that won the duel. */
  runId: string
}

export interface ClaimResponse {
  ok: true
  challengeId: string
  xp: number
  /** Reward items newly earned with it. */
  granted: string[]
}

export interface LegendRequest {
  /** Most outlaws beaten in one Legend run on this device. */
  beaten: number
}

export interface DailyResponse {
  spec: DailySpec
  /** Attempts used today by you (signed in) or this network (guest). */
  tries: number
  maxTries: number
  /** Your best winning time today, ms. */
  best: number | null
  /** Paid today already (signed in). */
  paid: boolean
  /** Epoch ms the day rolls over. */
  endsAt: number
}

export interface DailyBoardRow {
  rank: number
  name: string
  ms: number
}

export interface DailyBoardResponse {
  day: string
  rows: DailyBoardRow[]
  /** Your rank and time today (signed in and on the board), or null. */
  you: { rank: number; ms: number } | null
}

/** The `result` of a daily duel adds these (the ranked message's extra fields are ignored by old clients). */
export interface DailyResultExtra {
  /** Your place on today's board after this attempt (win only). */
  rank: number | null
  /** XP and dollars paid for today's win (0 if already paid, or a guest). */
  xp: number
}
