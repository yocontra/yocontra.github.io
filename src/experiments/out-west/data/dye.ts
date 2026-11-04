/**
 * Dye jobs (§5 shared sinks: $100–$2,000). A dye recolours one owned cosmetic. Cosmetic only: a dye
 * is a tint over the item's albedo and never changes its mesh, sound or silhouette. Pure data,
 * shared by the client (preview, prices) and the Worker (`POST /store/dye`). Owned by stream C.
 *
 * Rules:
 * - Only cloth and leather slots take dye (hat, outfit, holster, saddlebag, extra). Guns, spurs,
 *   frames and draw sounds don't.
 * - The price is 40% of the item's store price, rounded to $50, never under $100 or over $2,000.
 *   Starter and reward items (price $0) cost the minimum.
 * - `natural` washes a dye out. It is free.
 * - Re-dyeing an item to the colour it already has is refused.
 */
import { type CatalogItem, type ItemId, itemById, type Slot } from './catalog.ts'

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
/** The dye on each dyed item (absent = natural). */
export type Dyes = Partial<Record<ItemId, DyeId>>

/** Slots that take dye. */
export const DYEABLE_SLOTS: readonly Slot[] = ['hat', 'outfit', 'holster', 'saddlebag', 'extra']

/** A dye costs this share of the item's price, between the min and the max. */
export const DYE_SHARE = 0.4
export const DYE_PRICE_MIN = 100
export const DYE_PRICE_MAX = 2000
const DYE_STEP = 50

/** The dye job's price for an item, from its store price. */
export function dyeCost(item: CatalogItem): number {
  const raw = Math.round((item.price * DYE_SHARE) / DYE_STEP) * DYE_STEP
  return Math.min(DYE_PRICE_MAX, Math.max(DYE_PRICE_MIN, raw))
}

export function isDyeId(value: unknown): value is DyeId {
  return typeof value === 'string' && DYES.some((d) => d.id === value)
}

export function isDyeable(item: CatalogItem): boolean {
  return DYEABLE_SLOTS.includes(item.slot)
}

/** The price of dyeing `itemId` to `dye`: 0 to wash out, null if the item can't take dye. */
export function dyePrice(itemId: string, dye: DyeId): number | null {
  const item = itemById(itemId)
  if (!(item && isDyeable(item))) {
    return null
  }
  return dye === 'natural' ? 0 : dyeCost(item)
}

/** Why a dye job is refused, or `ok`. */
export type DyeVerdict = 'ok' | 'not_dyeable' | 'not_owned' | 'same' | 'funds'

export function canDye(opts: {
  itemId: string
  dye: DyeId
  owned: ReadonlySet<string>
  /** The item's current dye (null = natural). */
  current: DyeId | null
  purse: number
}): DyeVerdict {
  const price = dyePrice(opts.itemId, opts.dye)
  if (price === null) {
    return 'not_dyeable'
  }
  if (!opts.owned.has(opts.itemId)) {
    return 'not_owned'
  }
  if ((opts.current ?? 'natural') === opts.dye) {
    return 'same'
  }
  return opts.purse < price ? 'funds' : 'ok'
}

/** The dye's colour as a number for three.js, or null for natural. */
export function dyeHex(dye: DyeId | undefined): number | null {
  const d = DYES.find((x) => x.id === dye)
  return d?.hex ? Number.parseInt(d.hex.slice(1), 16) : null
}
