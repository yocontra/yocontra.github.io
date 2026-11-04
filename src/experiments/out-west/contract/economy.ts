/**
 * Wallet, ledger, XP, catalog and store request/response types.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream C.
 *
 *   GET  /me                  → MeResponse
 *   GET  /me/ledger?limit=50  → LedgerResponse (newest first, limit 1–200)
 *   PUT  /me/loadout          LoadoutRequest → LoadoutResponse   (only owned items)
 *   POST /me/prestige         → MeResponse                       (L50 only)
 *   POST /me/away/ack         AwayAckRequest → 204               (dismiss the "while you were away" notice)
 *   GET  /store               → StoreResponse                    (works signed out: owned = [])
 *   POST /store/buy           BuyRequest → BuyResponse
 *   POST /store/dye           DyeRequest → DyeResponse           (§5 dye jobs, $500–$2,000)
 *   GET  /board/most-wanted?month=YYYY-MM&limit=10 → MostWantedResponse
 *                             (Bearer optional: adds `you`)
 * Social, moderation and the other sinks (name change, a round for the house, public posters,
 * reports, blocks) are in `contract/social.ts`.
 * Errors are `{ ok: false, error }` with 400/401/402/403/404/409.
 */
import type { CatalogItem, ItemId, Loadout } from '../data/catalog.ts'
import type { DyeId } from '../data/dye.ts'

export const CONTRACT_VERSION = 1

/** Every reason money or XP moves. Mirrors the CHECK on `ledger.kind` in migration 0004. */
export const LEDGER_KINDS = [
  'start_grant',
  'gauntlet_clear',
  'duel_win',
  'duel_loss',
  /** A standoff that ended level (a dead heat never broken): XP only. */
  'duel_draw',
  /** Both players froze: XP only. */
  'duel_froze',
  'ghost_win',
  'ghost_royalty',
  'ffa_kill_mint',
  'ffa_deposit',
  'ffa_strongbox',
  'ffa_commission',
  'store_purchase',
  'level_reward',
  'admin_adjust',
  /** `POST /store/dye`: a dye job (debit). */
  'dye_job',
  /** `POST /me/name`: a name change (debit, $5,000). */
  'name_change',
  /** `POST /saloon/round`: "Buy the house a round" (debit, $1,000). */
  'house_round',
  /** A per-outlaw medal tier, from a server-judged ranked win (once per tier per outlaw). */
  'medal',
  /** A per-outlaw challenge (once each). Hat shots are claimed: XP only. */
  'challenge',
  /** The Daily Outlaw won (once per UTC day). */
  'daily_outlaw',
  /** A guest's device purse migrated into the account (once, capped). Never Most Wanted earnings. */
  'guest_migration',
] as const

/**
 * Kinds whose XP is single-player XP (`profiles.solo_xp`), which lowers the Outfitter's level gates
 * (`storeLevel` in data/progression.ts). Level rewards follow the XP that caused them, so aren't here.
 */
export const SOLO_KINDS = [
  'gauntlet_clear',
  'medal',
  'challenge',
  'daily_outlaw',
  'guest_migration',
] as const satisfies readonly LedgerKind[]
export type LedgerKind = (typeof LEDGER_KINDS)[number]

/**
 * The ledger kinds that count as *earnings* on the monthly Most Wanted board. Only credits
 * (positive amounts) of these kinds count; purchases, penalties, sinks, the start grant and admin
 * adjustments never do. Every one of them is booked by the server from a server-judged outcome.
 */
export const EARNING_KINDS = [
  'duel_win',
  'ghost_win',
  'ghost_royalty',
  'ffa_deposit',
  'ffa_commission',
  'ffa_strongbox',
  'gauntlet_clear',
  'level_reward',
  'medal',
  'challenge',
  'daily_outlaw',
] as const satisfies readonly LedgerKind[]
export type EarningKind = (typeof EARNING_KINDS)[number]

/** The wallet and progression for one account. */
export interface Profile {
  accountId: string
  name: string
  purse: number
  xp: number
  level: number
  prestige: number
  loadout: Loadout
}

export interface MeResponse extends Profile {
  title: string
  /** Live bounty at streak 0. */
  bounty: number
  /** XP into the current level, and needed for the next (0 at the cap). */
  xpInto: number
  xpNext: number
  owned: ItemId[]
  /** 17-bit mask of gauntlet outlaws cleared while signed in. */
  gauntletClears: number
  /**
   * The level the Outfitter's gates are checked against (solo levels count ~3×). Absent from an
   * older server: use `level`.
   */
  storeLevel?: number
  /** Dye per owned item that has one (absent = natural). */
  dyes: Partial<Record<ItemId, DyeId>>
  /** Passive earnings since your last visit, for the hub notice. See {@link AwayReport}. */
  away: AwayReport
}

/**
 * "While you were away" (§6): money that came in without you playing since you last dismissed the
 * hub notice. Show the notice when `total > 0`, e.g. "Your ghost gunned down 3 greenhorns while you
 * were away: +$41". When the player dismisses it, call `POST /me/away/ack { asOf }` with this
 * report's `asOf`, so anything that arrives later is still reported next time.
 */
export interface AwayReport {
  /** Epoch ms of the last acknowledgement (null if never: then it covers the last 7 days). */
  since: number | null
  /** Epoch ms this report runs up to. Pass it back to `POST /me/away/ack`. */
  asOf: number
  /** Ghost royalties: one per duel your ghost won. */
  royalties: { count: number; amount: number }
  /** Monthly Most Wanted placings awarded since (a dated frame each). */
  mostWanted: readonly { month: string; rank: number }[]
  /** Sum of all passive dollars in this report. */
  total: number
}

/** `POST /me/away/ack` (Bearer) → 204. `asOf` is clamped to now and never moves backwards. */
export interface AwayAckRequest {
  asOf: number
}

export interface LedgerRow {
  id: number
  kind: LedgerKind
  /** Whole dollars; credits positive, debits negative. */
  amount: number
  xp: number
  balanceAfter: number
  ref: string | null
  /** Unix ms. */
  createdAt: number
}

export interface LedgerResponse {
  entries: LedgerRow[]
}

export interface LoadoutRequest {
  loadout: Loadout
}

export interface LoadoutResponse {
  loadout: Loadout
}

export interface StoreResponse {
  catalogVersion: number
  items: readonly CatalogItem[]
  owned: ItemId[]
  /** Null when signed out. */
  purse: number | null
  level: number | null
}

export interface BuyRequest {
  itemId: ItemId
}

export interface BuyResponse {
  ok: true
  itemId: ItemId
  purse: number
  owned: ItemId[]
}

export interface ApiError {
  ok: false
  error: string
}

// --- dye jobs --------------------------------------------------------------------------------------

/** `POST /store/dye` (Bearer). `dye: 'natural'` washes a dye out for free. */
export interface DyeRequest {
  itemId: ItemId
  dye: DyeId
  /** Optional client nonce (8–64 chars) so a retried request can't charge twice. */
  requestId?: string
}

/**
 * 200 on success. Errors: 400 unknown item or dye / not dyeable, 403 not owned, 409 already that
 * colour, 402 can't afford.
 */
export interface DyeResponse {
  ok: true
  itemId: ItemId
  dye: DyeId
  /** What it cost (0 for natural). */
  price: number
  purse: number
  dyes: Partial<Record<ItemId, DyeId>>
}

// --- the monthly Most Wanted board -------------------------------------------------------------

export interface MostWantedRow {
  rank: number
  name: string
  /** Gross earnings that month (credits of EARNING_KINDS only). */
  earned: number
  level: number
  prestige: number
}

/**
 * `GET /board/most-wanted?month=YYYY-MM&limit=10`. `month` defaults to the current UTC month and
 * `limit` to 10 (1–50). Accounts in the Badlands or banned are left out and don't take a rank.
 * The current month is live; a past month is final.
 */
export interface MostWantedResponse {
  month: string
  /** False for the current month (still counting), true for a closed month. */
  final: boolean
  /** Epoch ms when the current month closes (start of next month, UTC). */
  closesAt: number
  rows: MostWantedRow[]
  /** Your own standing, when signed in (null rank if you earned nothing that month). */
  you: { rank: number | null; earned: number } | null
  /** The top 10 of the month before `month`, frozen at rollover (each got a dated frame). */
  previous: { month: string; winners: MostWantedRow[] }
}
