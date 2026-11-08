/**
 * Your Frontier record on this device: practice rounds finished, lifetime practice kills and
 * deaths (the practice town's bots read these, so a new player meets green bots), your best round,
 * whether you've ever banked (the first-bank objective chain), and the practice purse.
 *
 * The practice purse is what you've banked in the practice town. It lives only here, in this
 * browser, capped at `PRACTICE_PURSE_CAP`; it is never minted into the real economy (live lobbies
 * bank into your account's wallet on the server). Stored in localStorage, wrapped: a private
 * window or blocked storage just plays with a fresh record.
 */
import { MAX_FRONTIER_BOTS, MAX_PLAYERS } from '../sim/constants.ts'

const KEY = 'ow.frontier.record.v1'

/** The practice purse never holds more than this. */
export const PRACTICE_PURSE_CAP = 25_000

export interface FrontierRecord {
  /** Practice rounds finished (summary reached). */
  rounds: number
  kills: number
  deaths: number
  /** The best round's banked dollars and kills (practice or live). */
  bestBanked: number
  bestKills: number
  /** Banked at least once, anywhere: the first-bank objective chain is done. */
  firstBank: boolean
  /** Practice purse (dollars banked in the practice town, capped). */
  purse: number
}

const EMPTY: FrontierRecord = {
  rounds: 0,
  kills: 0,
  deaths: 0,
  bestBanked: 0,
  bestKills: 0,
  firstBank: false,
  purse: 0,
}

const count = (v: unknown, cap = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(cap, Math.max(0, Math.floor(v))) : 0

/** Larger artificial crowds exist only in explicitly enabled development/performance builds. */
export function practiceBots(requested = MAX_FRONTIER_BOTS, stress = false): number {
  return count(requested, stress ? MAX_PLAYERS - 1 : MAX_FRONTIER_BOTS)
}

export function loadRecord(): FrontierRecord {
  try {
    const raw = localStorage.getItem(KEY)
    const r: unknown = raw ? JSON.parse(raw) : null
    if (!r || typeof r !== 'object') {
      return { ...EMPTY }
    }
    const o = r as Record<string, unknown>
    return {
      rounds: count(o.rounds),
      kills: count(o.kills),
      deaths: count(o.deaths),
      bestBanked: count(o.bestBanked),
      bestKills: count(o.bestKills),
      firstBank: o.firstBank === true,
      purse: count(o.purse, PRACTICE_PURSE_CAP),
    }
  } catch {
    return { ...EMPTY }
  }
}

export function saveRecord(r: FrontierRecord): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...r, purse: Math.min(PRACTICE_PURSE_CAP, r.purse) }),
    )
  } catch {
    // Storage blocked or full: the record lasts for this visit only.
  }
}

/** Update the record in place and save it. */
export function patchRecord(patch: Partial<FrontierRecord>): FrontierRecord {
  const r = { ...loadRecord(), ...patch }
  saveRecord(r)
  return r
}

/** Lifetime practice kill/death ratio (1 with no record yet), for the bots' skill. */
export function practiceKd(r: FrontierRecord): number {
  if (r.kills + r.deaths < 10) {
    return 1
  }
  return r.kills / Math.max(1, r.deaths)
}

/** The practice town's lobby rules from this device's record. */
export function practiceOptions(r: FrontierRecord = loadRecord()): { rounds: number; kd: number } {
  return { rounds: r.rounds, kd: practiceKd(r) }
}
