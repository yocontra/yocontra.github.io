/**
 * Wire shapes and shared numbers for the social and money-sink endpoints, as the server's stream C
 * contract defines them (`contract/social.ts`, the additions to `contract/economy.ts`, and
 * `data/dye.ts` / `data/sinks.ts`). They live here, client side, until those files merge; then
 * these become re-exports. Pure: no DOM.
 *
 *   GET    /board/most-wanted?month=YYYY-MM&limit=  → MostWantedResponse (Bearer optional: `you`)
 *   GET    /players/:name                           → PlayerPoster        (Bearer optional)
 *   GET    /saloon/chalkboard                       → ChalkboardResponse
 *   POST   /saloon/round      RoundRequest          → RoundResponse       (Bearer, $1,000)
 *   POST   /me/name           NameChangeRequest     → NameChangeResponse  (Bearer, $5,000)
 *   POST   /reports           ReportRequest         → ReportResponse      (Bearer)
 *   GET    /blocks                                  → BlocksResponse      (Bearer)
 *   POST   /blocks            BlockRequest          → BlocksResponse      (Bearer)
 *   DELETE /blocks/:name                            → BlocksResponse      (Bearer)
 *   POST   /store/dye         DyeRequest            → DyeResponse         (Bearer, $500–$2,000)
 *   POST   /me/away/ack       AwayAckRequest        → 204                 (Bearer)
 *   POST   /me/prestige                             → MeResponse          (Bearer, L50)
 *   GET    /me                → MeResponse + MeExtras
 * Errors are `{ ok: false, error }`, shown as-is.
 */
import type { CatalogItem, ItemId, Loadout, Rarity, Slot } from '../data/catalog.ts'
import { itemById } from '../data/catalog.ts'

// --- prices and limits (data/sinks.ts) ---------------------------------------------------------

export const NAME_CHANGE_PRICE = 5000
export const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000
export const HOUSE_ROUND_PRICE = 1000
export const MOST_WANTED_WINNERS = 10
/** The reward frame for a top-10 month. */
export const MOST_WANTED_FRAME = 'frame.most-wanted-dated'

/** UTC month key, `YYYY-MM`. */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

/** The month before `month` (`YYYY-MM`). */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 1)).toISOString().slice(0, 7)
}

/** "November 2026" for `2026-11`. */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// --- dyes (data/dye.ts) ------------------------------------------------------------------------

export const DYES = [
  { id: 'natural', name: 'Natural', hex: null },
  { id: 'coal', name: 'Coal Black', hex: '#24211f' },
  { id: 'oxblood', name: 'Oxblood', hex: '#5e1f1d' },
  { id: 'rust', name: 'Rust', hex: '#8f4a22' },
  { id: 'sand', name: 'Sand', hex: '#c9b08a' },
  { id: 'sage', name: 'Sage', hex: '#7d8a68' },
  { id: 'indigo', name: 'Indigo', hex: '#2f3a63' },
  { id: 'bone', name: 'Bone White', hex: '#e7dfcf' },
] as const satisfies readonly { id: string; name: string; hex: string | null }[]

export type DyeId = (typeof DYES)[number]['id']
export type Dyes = Partial<Record<ItemId, DyeId>>

/** Slots that take dye: cloth and leather. Guns, spurs, frames and draw sounds don't. */
export const DYEABLE_SLOTS: readonly Slot[] = ['hat', 'outfit', 'holster', 'saddlebag', 'extra']

const DYE_PRICE: Readonly<Record<Rarity, number>> = {
  starter: 500,
  common: 500,
  uncommon: 1000,
  rare: 1500,
  legendary: 2000,
  reward: 2000,
}

export const isDyeId = (value: unknown): value is DyeId =>
  typeof value === 'string' && DYES.some((d) => d.id === value)

export const isDyeable = (item: CatalogItem): boolean => DYEABLE_SLOTS.includes(item.slot)

/** The price of dyeing `itemId` to `dye`: 0 to wash out, null if the item can't take dye. */
export function dyePrice(itemId: string, dye: DyeId): number | null {
  const item = itemById(itemId)
  if (!(item && isDyeable(item))) {
    return null
  }
  return dye === 'natural' ? 0 : DYE_PRICE[item.rarity]
}

/** The dye's colour as a number for three.js, or null for natural. */
export function dyeHex(dye: DyeId | undefined): number | null {
  const d = DYES.find((x) => x.id === dye)
  return d?.hex ? Number.parseInt(d.hex.slice(1), 16) : null
}

export interface DyeRequest {
  itemId: ItemId
  dye: DyeId
  requestId?: string
}

export interface DyeResponse {
  ok: true
  itemId: ItemId
  dye: DyeId
  price: number
  purse: number
  dyes: Dyes
}

// --- the profile's extras (contract/economy.ts) ----------------------------------------------

/** "While you were away": passive money since the hub notice was last dismissed. */
export interface AwayReport {
  since: number | null
  /** Pass back to `POST /me/away/ack`. */
  asOf: number
  royalties: { count: number; amount: number }
  mostWanted: readonly { month: string; rank: number }[]
  total: number
}

/** Fields `GET /me` adds on the server branch (read defensively: absent until it merges). */
export interface MeExtras {
  dyes?: Dyes
  away?: AwayReport
}

// --- the monthly Most Wanted board -------------------------------------------------------------

export interface MostWantedRow {
  rank: number
  name: string
  earned: number
  level: number
  prestige: number
}

export interface MostWantedResponse {
  month: string
  /** False for the current month (still counting). */
  final: boolean
  /** Epoch ms when the current month closes. */
  closesAt: number
  rows: MostWantedRow[]
  you: { rank: number | null; earned: number } | null
  previous: { month: string; winners: MostWantedRow[] }
}

// --- public posters ----------------------------------------------------------------------------

export interface PlayerPoster {
  name: string
  level: number
  prestige: number
  title: string
  bounty: number
  licensed: boolean
  loadout: Loadout
  dyes: Dyes
  duel: {
    streak: number
    bestStreak: number
    wins: number
    losses: number
    draws: number
    cowardice: number
  }
  frontier: { kills: number; deaths: number; banked: number }
  mostWanted: readonly { month: string; rank: number }[]
  joinedAt: number
  /** Null when signed out or it's you. */
  blockedByYou: boolean | null
}

// --- name change and the house round -----------------------------------------------------------

export interface NameChangeResponse {
  ok: true
  name: string
  purse: number
  nextChangeAt: number
}

export interface ChalkboardLine {
  name: string
  at: number
}

export interface ChalkboardResponse {
  rounds: ChalkboardLine[]
}

export interface RoundResponse {
  ok: true
  purse: number
  rounds: ChalkboardLine[]
}

// --- reports and blocks ------------------------------------------------------------------------

export const REPORT_REASONS = ['name', 'cheating', 'abuse'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

export const REPORT_LABELS: Readonly<Record<ReportReason, string>> = {
  name: 'An offensive name',
  cheating: 'Cheating',
  abuse: 'Abuse or harassment',
}

export interface ReportRequest {
  name: string
  reason: ReportReason
  context?: string
  block?: boolean
}

export interface ReportResponse {
  ok: true
  blocked: boolean
}

export interface BlocksResponse {
  ok: true
  blocked: string[]
}
