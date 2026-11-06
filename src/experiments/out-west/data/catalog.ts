/**
 * The Outfitter's catalog: every cosmetic item, its price, rarity and level gate. Cosmetic only:
 * nothing here may change timing or damage. Pure data. Owned by stream C.
 *
 * Rules (enforced by `api/src/economy/catalog.test.ts`):
 * - Items carry only presentation fields. No item may carry a gameplay stat.
 * - No cosmetic sound may use a bell timbre, so nothing can be mistaken for the call.
 * - Draw sounds trigger only on the shot, and spur jingles only while walking.
 * - In Frontier FFA, no cosmetic changes the silhouette by more than ±10% of the capsule.
 * - Prices and level gates sit inside their rarity band. Prices are fixed; nothing is random,
 *   tradeable or resellable.
 *
 * Bump CATALOG_VERSION whenever an item is added, removed or repriced.
 */
export const CATALOG_VERSION = 4

export const SLOTS = [
  'gun',
  'hat',
  'outfit',
  'spurs',
  'holster',
  'frame',
  'drawSound',
  'saddlebag',
  'extra',
] as const
export type Slot = (typeof SLOTS)[number]

export type Rarity = 'starter' | 'common' | 'uncommon' | 'rare' | 'legendary' | 'reward'

/** How an item is obtained: free at sign-up, bought in the Outfitter, or earned. */
export type ItemSource = 'starter' | 'store' | 'reward'

/** A timbre tag for any item that makes a sound. `bell`-like timbres are banned (see the lint). */
export type Timbre =
  | 'gunshot'
  | 'thunder'
  | 'cannon'
  | 'hawk-cry'
  | 'spur-jingle'
  | 'spur-rattle'
  | 'leather'
  | 'cloth'
  | 'coin-clink'

/** When an item's sound may play. A draw sound plays on the shot; spurs only while walking. */
export type SoundTrigger = 'shot' | 'walk'

export interface ItemSound {
  readonly timbre: Timbre
  readonly trigger: SoundTrigger
}

interface CatalogItemShape {
  readonly id: string
  readonly name: string
  readonly slot: Slot
  readonly rarity: Rarity
  /** Whole dollars. 0 for starters and rewards. */
  readonly price: number
  /** Minimum level to buy. 1 for starters and rewards. */
  readonly level: number
  readonly source: ItemSource
  /** How a reward is earned (reward items only). */
  readonly unlock?: string
  readonly sound?: ItemSound
  /** Frontier FFA silhouette scale relative to the capsule, 0.9–1.1. Omitted means 1. */
  readonly silhouette?: number
}

type Item<I extends string> = CatalogItemShape & { readonly id: I }

const starter = <const I extends string>(
  id: I,
  name: string,
  slot: Slot,
  sound?: ItemSound,
): Item<I> => ({
  id,
  name,
  slot,
  rarity: 'starter',
  price: 0,
  level: 1,
  source: 'starter',
  ...(sound ? { sound } : {}),
})

/** `[rarity, price, level gate, presentation extras]`. */
type StoreBand = readonly [
  Exclude<Rarity, 'starter' | 'reward'>,
  number,
  number,
  Pick<CatalogItemShape, 'sound' | 'silhouette'>?,
]

const store = <const I extends string>(
  id: I,
  name: string,
  slot: Slot,
  [rarity, price, level, extra = {}]: StoreBand,
): Item<I> => ({ id, name, slot, rarity, price, level, source: 'store', ...extra })

const reward = <const I extends string>(
  id: I,
  name: string,
  slot: Slot,
  unlock: string,
): Item<I> => ({
  id,
  name,
  slot,
  rarity: 'reward',
  price: 0,
  level: 1,
  source: 'reward',
  unlock,
})

const SHOT = (timbre: Timbre): ItemSound => ({ timbre, trigger: 'shot' })
const WALK = (timbre: Timbre): ItemSound => ({ timbre, trigger: 'walk' })

/** Every item. Order is display order within a slot. */
export const CATALOG = [
  // Gun
  starter('gun.rusty-six', 'Rusty Six', 'gun'),
  store('gun.blued-six', 'Blued Six-Shooter', 'gun', ['common', 300, 1]),
  store('gun.nickel-six', 'Nickel Six', 'gun', ['uncommon', 900, 3]),
  store('gun.engraved-ivory', 'Engraved Ivory', 'gun', ['rare', 8000, 15]),
  store('gun.buntline', 'Buntline Long Nine', 'gun', ['rare', 12_000, 20]),
  store('gun.gilded-sovereign', 'Gilded Sovereign', 'gun', ['legendary', 35_000, 35]),
  reward('gun.hardins-pair', "Hardin's Pair", 'gun', 'Clear the full gauntlet'),
  reward('gun.gold-medal', 'Gold Medal Six', 'gun', 'Gold on all 17 outlaws'),
  // Hat
  starter('hat.battered-brim', 'Battered Brim', 'hat'),
  store('hat.plainsman', 'Plainsman', 'hat', ['common', 250, 1]),
  store('hat.sombrero', 'Sombrero', 'hat', ['uncommon', 750, 3, { silhouette: 1.08 }]),
  store('hat.stovepipe', 'Stovepipe', 'hat', ['uncommon', 1000, 5, { silhouette: 1.06 }]),
  store('hat.rattler-band', 'Rattler Band', 'hat', ['rare', 7500, 18]),
  store('hat.ghost-white', 'Ghost-White Cattleman', 'hat', ['legendary', 30_000, 40]),
  reward('hat.yellow', 'Yellow Hat', 'hat', 'Draw early 10 times'),
  reward('hat.bronze-band', 'Bronze Band', 'hat', 'Bronze on all 17 outlaws'),
  reward('hat.holed-stetson', 'Holed Stetson', 'hat', 'Shoot the hat off all three hat outlaws'),
  // Outfit
  starter('outfit.trail-duds', 'Trail Duds', 'outfit', WALK('cloth')),
  store('outfit.shirt-vest', 'Shirt & Vest', 'outfit', ['common', 350, 1]),
  store('outfit.wool-duster', 'Wool Duster', 'outfit', ['uncommon', 900, 3, { silhouette: 1.05 }]),
  store('outfit.striped-poncho', 'Striped Poncho', 'outfit', [
    'uncommon',
    1100,
    4,
    {
      silhouette: 1.05,
    },
  ]),
  store('outfit.gamblers-frock', "Gambler's Frock", 'outfit', ['rare', 9000, 16]),
  store('outfit.bandolier-rig', 'Bandolier Rig', 'outfit', ['rare', 11_000, 22]),
  store('outfit.undertakers-black', "Undertaker's Black", 'outfit', ['legendary', 45_000, 45]),
  reward(
    'outfit.midnight-coat',
    'Midnight Coat',
    'outfit',
    'Kill Hardin without drawing early on him',
  ),
  // Spurs
  starter('spurs.plain-rowels', 'Plain Rowels', 'spurs', WALK('spur-rattle')),
  store('spurs.silver-jinglebobs', 'Silver Jinglebobs', 'spurs', [
    'uncommon',
    1750,
    6,
    {
      sound: WALK('spur-jingle'),
    },
  ]),
  store('spurs.star-rowels', 'Star Rowels', 'spurs', [
    'rare',
    14_000,
    25,
    {
      sound: WALK('spur-rattle'),
    },
  ]),
  reward('spurs.legend-rowels', 'Legend Rowels', 'spurs', 'Beat 6 outlaws in one Legend run'),
  // Holster
  starter('holster.plain-leather', 'Plain Leather', 'holster'),
  store('holster.tooled-floral', 'Tooled Floral', 'holster', ['uncommon', 1100, 4]),
  store('holster.buscadero', 'Buscadero Rig', 'holster', ['rare', 10_000, 20]),
  reward('holster.silver-conchos', 'Silver Conchos', 'holster', 'Silver on all 17 outlaws'),
  // Poster frame
  starter('frame.pine-board', 'Pine Board', 'frame'),
  store('frame.brass-tacks', 'Brass Tacks', 'frame', ['uncommon', 1000, 5]),
  store('frame.gilt-saloon', 'Gilt Saloon', 'frame', ['rare', 8000, 24]),
  store('frame.most-wanted-gilt', 'Most Wanted Gilt', 'frame', ['legendary', 40_000, 50]),
  reward('frame.midnight', 'Midnight', 'frame', 'Clear the full gauntlet without drawing early'),
  reward(
    'frame.most-wanted-dated',
    'Most Wanted (dated)',
    'frame',
    'Finish a month in the top 10 of the Most Wanted board',
  ),
  reward('frame.tall-tales', 'Tall Tales', 'frame', 'Finish all 17 challenges'),
  reward('frame.legend', 'Legend’s Laurel', 'frame', 'Beat 9 outlaws in one Legend run'),
  // Draw sound
  starter('sound.standard', 'Standard Report', 'drawSound', SHOT('gunshot')),
  store('sound.thunder-crack', 'Thunder Crack', 'drawSound', [
    'uncommon',
    750,
    2,
    {
      sound: SHOT('thunder'),
    },
  ]),
  store('sound.cannon-boom', 'Cannon Boom', 'drawSound', [
    'rare',
    9000,
    19,
    {
      sound: SHOT('cannon'),
    },
  ]),
  store('sound.thunderclap-hawk', 'Thunderclap & Hawk', 'drawSound', [
    'legendary',
    28_000,
    38,
    {
      sound: SHOT('hawk-cry'),
    },
  ]),
  // Saddlebag (the bag you drop in Frontier FFA)
  starter('bag.plain-sack', 'Plain Sack', 'saddlebag'),
  store('bag.branded-satchel', 'Branded Satchel', 'saddlebag', ['uncommon', 1250, 4]),
  store('bag.gold-thread', 'Gold-Thread Purse', 'saddlebag', ['rare', 12_000, 26]),
  reward('bag.medal-satchel', 'Medal Satchel', 'saddlebag', 'Win 25 medals'),
  // Extra
  store('extra.handlebar', 'Handlebar Moustache', 'extra', ['common', 250, 1]),
  store('extra.red-bandana', 'Red Bandana', 'extra', ['common', 400, 2]),
  store('extra.tin-star', 'Tin Star', 'extra', ['uncommon', 2000, 7]),
  reward('extra.black-bandana', 'Black Bandana', 'extra', 'Win the Daily Outlaw on 7 days'),
] as const satisfies readonly CatalogItemShape[]

export type CatalogItem = (typeof CATALOG)[number]
export type ItemId = CatalogItem['id']

const BY_ID: ReadonlyMap<string, CatalogItem> = new Map(CATALOG.map((item) => [item.id, item]))

export function isItemId(id: unknown): id is ItemId {
  return typeof id === 'string' && BY_ID.has(id)
}

export function itemById(id: string): CatalogItem | undefined {
  return BY_ID.get(id)
}

/** The equipped cosmetics: one item per slot. `extra` is optional; every other slot is filled. */
export interface Loadout {
  gun: ItemId
  hat: ItemId
  outfit: ItemId
  spurs: ItemId
  holster: ItemId
  frame: ItemId
  drawSound: ItemId
  saddlebag: ItemId
  extra: ItemId | null
}

/** The eight starter items, granted and equipped at sign-up. */
export const DEFAULT_LOADOUT: Readonly<Loadout> = {
  gun: 'gun.rusty-six',
  hat: 'hat.battered-brim',
  outfit: 'outfit.trail-duds',
  spurs: 'spurs.plain-rowels',
  holster: 'holster.plain-leather',
  frame: 'frame.pine-board',
  drawSound: 'sound.standard',
  saddlebag: 'bag.plain-sack',
  extra: null,
}

export const STARTER_ITEMS: readonly ItemId[] = CATALOG.filter((i) => i.source === 'starter').map(
  (i) => i.id,
)

/** Why a purchase is refused, or `ok`. */
export type BuyVerdict = 'ok' | 'not_for_sale' | 'owned' | 'level' | 'funds'

/**
 * Whether `profile` may buy `item` now. Server-authoritative in `POST /store/buy`; the client uses
 * it only to grey out buttons. `storeLevel` (from `GET /me`) is the level gates are checked against;
 * an old profile without it is checked against its level.
 */
export function canBuy(
  profile: { readonly level: number; readonly purse: number; readonly storeLevel?: number },
  item: CatalogItem,
  owned: ReadonlySet<string> = new Set(),
): BuyVerdict {
  if (item.source !== 'store') {
    return 'not_for_sale'
  }
  if (owned.has(item.id)) {
    return 'owned'
  }
  // the store level (solo levels count ~3×, data/progression.ts storeLevel); never below the level
  if (Math.max(profile.level, profile.storeLevel ?? 0) < item.level) {
    return 'level'
  }
  if (profile.purse < item.price) {
    return 'funds'
  }
  return 'ok'
}

/** Why a loadout is refused, or null when it is valid against `owned`. */
export function loadoutError(value: unknown, owned: ReadonlySet<string>): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'Loadout must be an object.'
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(SLOTS as readonly string[]).includes(key)) {
      return `Unknown slot ${key}.`
    }
  }
  for (const slot of SLOTS) {
    const id = record[slot]
    if (slot === 'extra' && (id === null || id === undefined)) {
      continue
    }
    if (!isItemId(id)) {
      return `Unknown item in ${slot}.`
    }
    if (itemById(id)?.slot !== slot) {
      return `${id} doesn't go in ${slot}.`
    }
    if (!owned.has(id)) {
      return `You don't own ${id}.`
    }
  }
  return null
}

/**
 * Reads a stored loadout, replacing any unknown or misplaced id with the starter for that slot.
 * Never throws: an old or corrupt row still renders.
 */
export function normalizeLoadout(value: unknown): Loadout {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >
  const pick = (slot: Exclude<Slot, 'extra'>): ItemId => {
    const id = record[slot]
    return isItemId(id) && itemById(id)?.slot === slot ? id : DEFAULT_LOADOUT[slot]
  }
  const extra = record.extra
  return {
    gun: pick('gun'),
    hat: pick('hat'),
    outfit: pick('outfit'),
    spurs: pick('spurs'),
    holster: pick('holster'),
    frame: pick('frame'),
    drawSound: pick('drawSound'),
    saddlebag: pick('saddlebag'),
    extra: isItemId(extra) && itemById(extra)?.slot === 'extra' ? extra : null,
  }
}
