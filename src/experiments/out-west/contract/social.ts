/**
 * Public posters, moderation (reports and blocks) and the social money sinks (name change, a round
 * for the house). Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no
 * Workers types, no imports outside `contract/` and `data/`. Owned by stream C.
 *
 *   GET    /players/:name        → PlayerPoster       (public; 404 unknown or banned)
 *   POST   /me/name              NameChangeRequest → NameChangeResponse   (Bearer, $5,000)
 *   GET    /saloon/chalkboard    → ChalkboardResponse (public)
 *   POST   /saloon/round         RoundRequest → RoundResponse             (Bearer, $1,000)
 *   POST   /reports              ReportRequest → ReportResponse           (Bearer)
 *   GET    /blocks               → BlocksResponse                         (Bearer)
 *   POST   /blocks               BlockRequest → BlocksResponse            (Bearer)
 *   DELETE /blocks               BlockRequest → BlocksResponse            (Bearer; also DELETE /blocks/:name)
 *
 * Errors are `{ ok: false, error }` with a message the client can show as-is.
 *
 * `:name` is the display name, URL-encoded (`/players/Doc%20Holliday`); the lookup is by the name
 * key, so case and spacing don't matter. Blocking is private: the blocked player is never told.
 * Blocked players are never matched together: not in the Bounty Hunt queue, not as each other's
 * ghost, and not in a Frontier call-out.
 */
import type { ItemId, Loadout } from '../data/catalog.ts'
import type { DyeId } from '../data/dye.ts'

// --- public poster -------------------------------------------------------------------------------

export interface PlayerPoster {
  name: string
  level: number
  prestige: number
  title: string
  /** Live bounty: base bounty with the hot-streak bonus. */
  bounty: number
  licensed: boolean
  loadout: Loadout
  dyes: Partial<Record<ItemId, DyeId>>
  /** Bounty Hunt record. */
  duel: {
    streak: number
    bestStreak: number
    wins: number
    losses: number
    draws: number
    /** Public cowardice tally. */
    cowardice: number
  }
  /** Frontier record. */
  frontier: { kills: number; deaths: number; banked: number }
  /** Months finished in the Most Wanted top 10 (newest first). */
  mostWanted: readonly { month: string; rank: number }[]
  /** Epoch ms the account was created. */
  joinedAt: number
  /** When signed in: whether you block this player (null when signed out or it's you). */
  blockedByYou: boolean | null
}

// --- name change ---------------------------------------------------------------------------------

/**
 * `POST /me/name`: costs NAME_CHANGE_PRICE ($5,000, data/sinks.ts), at most once per 30 days. The
 * new name follows the sign-up rules (names.ts) and must be free: not another account's, not held
 * after someone's deletion or name change, not mid-registration. Your old name is held for you for
 * 30 days, so you can change back and nobody can take it meanwhile.
 *
 * Errors: 400 invalid name, 409 taken or same as now, 429 cooldown (`retryAfterS` in the body),
 * 402 can't afford. The access token keeps the old name until it refreshes (≤15 min); `GET /me`
 * shows the new one at once.
 */
export interface NameChangeRequest {
  name: string
}

export interface NameChangeResponse {
  ok: true
  name: string
  purse: number
  /** Epoch ms when the next change is allowed. */
  nextChangeAt: number
}

// --- a round for the house -----------------------------------------------------------------------

export interface ChalkboardLine {
  name: string
  /** Epoch ms. */
  at: number
}

/** `GET /saloon/chalkboard`: the most recent rounds, newest first. */
export interface ChalkboardResponse {
  rounds: ChalkboardLine[]
}

/** `POST /saloon/round`: HOUSE_ROUND_PRICE ($1,000) puts your name on the chalkboard. */
export interface RoundRequest {
  /** Optional client nonce (8–64 chars) so a retried tap can't buy twice. */
  requestId?: string
}

export interface RoundResponse {
  ok: true
  purse: number
  rounds: ChalkboardLine[]
}

// --- reports and blocks --------------------------------------------------------------------------

export const REPORT_REASONS = ['name', 'cheating', 'abuse'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

/**
 * `POST /reports`. One report per target per day counts (a repeat is accepted and ignored). Only
 * licensed players' reports count toward moderation. 404 unknown player, 400 bad reason or self.
 */
export interface ReportRequest {
  name: string
  reason: ReportReason
  /** The match id or lobby id this is about, if any (≤80 chars). */
  context?: string
  /** Also block them (the poster's "Report and block"). */
  block?: boolean
}

export interface ReportResponse {
  ok: true
  /** True when this player now blocks the target. */
  blocked: boolean
}

export interface BlockRequest {
  name: string
}

export interface BlocksResponse {
  ok: true
  /** Names you block, newest first (max MAX_BLOCKS = 200). */
  blocked: string[]
}
