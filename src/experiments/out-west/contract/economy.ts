/**
 * Wallet, ledger, XP, catalog and store request/response types.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream C.
 *
 *   GET  /me                  → MeResponse
 *   GET  /me/ledger?limit=50  → LedgerResponse (newest first, limit 1–200)
 *   PUT  /me/loadout          LoadoutRequest → LoadoutResponse   (only owned items)
 *   POST /me/prestige         → MeResponse                       (L50 only)
 *   GET  /store               → StoreResponse                    (works signed out: owned = [])
 *   POST /store/buy           BuyRequest → BuyResponse
 * Errors are `{ ok: false, error }` with 400/401/402/403/404/409.
 */
import type { CatalogItem, ItemId, Loadout } from '../data/catalog.ts'

export const CONTRACT_VERSION = 1

/** Every reason money or XP moves. Mirrors the CHECK on `ledger.kind` in migration 0004. */
export const LEDGER_KINDS = [
  'start_grant',
  'gauntlet_clear',
  'duel_win',
  'duel_loss',
  'ghost_win',
  'ghost_royalty',
  'ffa_kill_mint',
  'ffa_deposit',
  'ffa_strongbox',
  'ffa_commission',
  'store_purchase',
  'level_reward',
  'admin_adjust',
] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

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
