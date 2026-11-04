/**
 * The Outfitter's shelf labels: matched sets (pieces that belong together, tried on in one tap),
 * the "New" badge (kit that came within your reach since you last looked, remembered per account
 * on this device) and the "Can afford" badge. Presentation only: prices, gates and ownership are
 * the server's.
 */
import type { CatalogItem, ItemId, Loadout } from '../data/catalog.ts'

export interface KitSet {
  id: string
  name: string
  blurb: string
  items: readonly ItemId[]
}

/** Matched sets. Every piece is sold on its own; a set is how they were meant to be worn. */
export const SETS: readonly KitSet[] = [
  {
    id: 'trail-hand',
    name: 'Trail Hand',
    blurb: 'Honest work clothes for an honest draw.',
    items: ['hat.plainsman', 'outfit.shirt-vest', 'gun.blued-six'],
  },
  {
    id: 'vaquero',
    name: 'Vaquero',
    blurb: 'Wide brim, bright wool, a jingle at every step.',
    items: ['hat.sombrero', 'outfit.striped-poncho', 'spurs.silver-jinglebobs'],
  },
  {
    id: 'riverboat',
    name: 'Riverboat Gambler',
    blurb: 'Dressed for the card table, armed for what comes after.',
    items: [
      'hat.stovepipe',
      'outfit.gamblers-frock',
      'gun.engraved-ivory',
      'holster.tooled-floral',
    ],
  },
  {
    id: 'buscadero',
    name: 'Buscadero',
    blurb: 'Rattlesnake band, a belt of brass and a long barrel.',
    items: ['hat.rattler-band', 'outfit.bandolier-rig', 'holster.buscadero', 'gun.buntline'],
  },
  {
    id: 'pale-rider',
    name: 'Pale Rider',
    blurb: 'White hat, black coat, gold gun. They’ll remember you.',
    items: [
      'hat.ghost-white',
      'outfit.undertakers-black',
      'gun.gilded-sovereign',
      'spurs.star-rowels',
    ],
  },
]

export const setOf = (id: string): KitSet | undefined =>
  SETS.find((s) => s.items.includes(id as ItemId))

/** Your loadout with every piece of the set swapped in. */
export function wearSet(base: Loadout, set: KitSet, items: readonly CatalogItem[]): Loadout {
  const next: Loadout = { ...base }
  for (const id of set.items) {
    const item = items.find((i) => i.id === id)
    if (item) {
      Object.assign(next, { [item.slot]: item.id })
    }
  }
  return next
}

// ------------------------------------------------------------------------------------- badges

const KEY = 'ow.store.seen.v1:'

function readSeen(account: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(KEY + account)
    const v: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : null
  } catch {
    return null
  }
}

function writeSeen(account: string, seen: Set<string>): void {
  try {
    localStorage.setItem(KEY + account, JSON.stringify([...seen]))
  } catch {
    // private mode: the badges just come back next visit
  }
}

/** Kit you could buy at your level (not owned, not a reward, priced). */
export const inReach = (item: CatalogItem, level: number, owned: ReadonlySet<string>): boolean =>
  item.source === 'store' && item.price > 0 && level >= item.level && !owned.has(item.id)

/**
 * What's new on the shelf for this account: in reach now, not in reach when you last looked.
 * The first visit on a device is the baseline (nothing is new). `look` marks a slot's items seen
 * after the badges have been shown once.
 */
export class Shelf {
  private readonly account: string
  private readonly seen: Set<string>
  private readonly fresh: Set<string>

  constructor(
    account: string,
    items: readonly CatalogItem[],
    level: number,
    owned: ReadonlySet<string>,
  ) {
    this.account = account
    const seen = readSeen(account)
    const reach = items.filter((i) => inReach(i, level, owned)).map((i) => i.id)
    this.seen = seen ?? new Set(reach)
    this.fresh = new Set(reach.filter((id) => !this.seen.has(id)))
    if (!seen) {
      writeSeen(account, this.seen)
    }
  }

  isNew(id: string): boolean {
    return this.fresh.has(id)
  }

  /** New pieces in a slot (for the tab's dot). */
  newIn(items: readonly CatalogItem[]): number {
    return items.filter((i) => this.fresh.has(i.id)).length
  }

  /** Remember these as seen (the badge stays up for the rest of this visit). */
  look(items: readonly CatalogItem[]): void {
    let changed = false
    for (const i of items) {
      if (this.fresh.has(i.id) && !this.seen.has(i.id)) {
        this.seen.add(i.id)
        changed = true
      }
    }
    if (changed) {
      writeSeen(this.account, this.seen)
    }
  }
}
