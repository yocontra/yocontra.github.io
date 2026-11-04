/**
 * The catalog lint (spec §7): cosmetic only, no bell timbres, sounds on the right trigger, fair
 * silhouettes, prices inside their rarity band. Runs in `bun run check` via `bun test api`.
 */
import { describe, expect, it } from 'bun:test'
import {
  CATALOG,
  type CatalogItem,
  canBuy,
  DEFAULT_LOADOUT,
  itemById,
  loadoutError,
  normalizeLoadout,
  SLOTS,
  STARTER_ITEMS,
} from '../../../src/experiments/out-west/data/catalog.ts'

const ITEMS: readonly CatalogItem[] = CATALOG

/** The only fields an item may carry. Anything else could be a gameplay stat. */
const ALLOWED_KEYS = new Set([
  'id',
  'name',
  'slot',
  'rarity',
  'price',
  'level',
  'source',
  'unlock',
  'sound',
  'silhouette',
])

/** Words that suggest a gameplay stat, checked against every key at any depth. */
const STAT_WORDS =
  /damage|dmg|speed|reload|range|accuracy|spread|ammo|fire|rate|hp|health|armou?r|timing|delay|ms$|tolerance|crit|bonus|multiplier|clip|hitbox|capsule/iu

/**
 * The bell-sound rule: no cosmetic may sound like the call. Until audio fingerprinting lands, this
 * is a name and tag rule over the item's name, id and sound timbre.
 */
const BELL_LIKE = /bell|chime|ding|dong|gong|toll|clang|triangle|ring(?!er)|peal|carillon|knell/iu

const OWN = /own/u
const UNKNOWN = /Unknown/u
const GO_IN = /go in/u
const SLOT = /slot/u

const RARITY_BANDS: Record<string, { price: [number, number]; level: [number, number] }> = {
  common: { price: [250, 500], level: [1, 4] },
  uncommon: { price: [1500, 4000], level: [4, 14] },
  rare: { price: [7500, 14_000], level: [15, 26] },
  legendary: { price: [25_000, 45_000], level: [30, 50] },
}

/** Draw sounds must trigger on the shot; any other sound (spurs, cloth) only while walking. */
function expectedTrigger(item: CatalogItem): string {
  if (item.slot === 'drawSound') {
    return 'shot'
  }
  return item.sound ? 'walk' : 'none'
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      keysDeep(v, out)
    }
  }
  return out
}

describe('catalog shape', () => {
  it('has the 40 spec items plus the non-store rewards (4 originals, 10 gauntlet-earned)', () => {
    const bySource = (s: string) => ITEMS.filter((i) => i.source === s)
    expect(bySource('starter')).toHaveLength(8)
    expect(bySource('store')).toHaveLength(31)
    expect(bySource('reward').map((i) => i.id)).toEqual([
      'gun.hardins-pair',
      'gun.gold-medal',
      'hat.yellow',
      'hat.bronze-band',
      'hat.holed-stetson',
      'outfit.midnight-coat',
      'spurs.legend-rowels',
      'holster.silver-conchos',
      'frame.midnight',
      'frame.most-wanted-dated',
      'frame.tall-tales',
      'frame.legend',
      'bag.medal-satchel',
      'extra.black-bandana',
    ])
    expect(ITEMS).toHaveLength(53)
    expect(bySource('store').reduce((sum, i) => sum + i.price, 0)).toBe(306_950)
  })

  it('ids are unique and slot-prefixed', () => {
    expect(new Set(ITEMS.map((i) => i.id)).size).toBe(ITEMS.length)
    const prefix: Record<string, string> = { drawSound: 'sound', saddlebag: 'bag' }
    for (const item of ITEMS) {
      expect(item.id.startsWith(`${prefix[item.slot] ?? item.slot}.`)).toBe(true)
    }
  })

  it('one starter per slot except extra, and the default loadout is exactly the starters', () => {
    for (const slot of SLOTS) {
      const starters = ITEMS.filter((i) => i.slot === slot && i.source === 'starter')
      expect(starters).toHaveLength(slot === 'extra' ? 0 : 1)
    }
    const equipped = Object.values(DEFAULT_LOADOUT).filter((v) => v !== null)
    expect(new Set(equipped)).toEqual(new Set(STARTER_ITEMS))
  })

  it('prices and level gates sit inside their rarity band', () => {
    for (const item of ITEMS.filter((i) => !RARITY_BANDS[i.rarity])) {
      expect(item.price).toBe(0)
    }
    for (const item of ITEMS.filter((i) => RARITY_BANDS[i.rarity])) {
      const band = RARITY_BANDS[item.rarity] ?? { price: [0, 0], level: [0, 0] }
      expect(item.price).toBeGreaterThanOrEqual(band.price[0])
      expect(item.price).toBeLessThanOrEqual(band.price[1])
      expect(item.level).toBeGreaterThanOrEqual(band.level[0])
      expect(item.level).toBeLessThanOrEqual(band.level[1])
      expect(Number.isInteger(item.price)).toBe(true)
    }
  })
})

describe('cosmetic only', () => {
  it('no item carries a gameplay stat', () => {
    for (const item of ITEMS) {
      for (const key of Object.keys(item)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true)
      }
      for (const key of keysDeep(item)) {
        expect(STAT_WORDS.test(key)).toBe(false)
      }
    }
  })

  it('no cosmetic sound resembles the bell', () => {
    for (const item of ITEMS) {
      expect(BELL_LIKE.test(item.name)).toBe(false)
      expect(BELL_LIKE.test(item.id)).toBe(false)
      expect(BELL_LIKE.test(item.sound?.timbre ?? '')).toBe(false)
    }
  })

  it('the bell rule catches the obvious offenders', () => {
    for (const bad of ['Church Bell', 'sound.chime', 'Dinner Gong', 'Death Knell', 'ringing']) {
      expect(BELL_LIKE.test(bad)).toBe(true)
    }
  })

  it('draw sounds play only on the shot, spurs only while walking', () => {
    for (const item of ITEMS) {
      expect(item.sound?.trigger ?? 'none').toBe(expectedTrigger(item))
    }
  })

  it('guns and holsters never change the silhouette', () => {
    const fixed = ITEMS.filter((i) => i.slot === 'gun' || i.slot === 'holster')
    expect(fixed.filter((i) => i.silhouette !== undefined)).toEqual([])
  })

  it('no cosmetic changes the silhouette by more than ±10%', () => {
    for (const item of ITEMS) {
      const s = item.silhouette ?? 1
      expect(s).toBeGreaterThanOrEqual(0.9)
      expect(s).toBeLessThanOrEqual(1.1)
    }
  })
})

describe('canBuy', () => {
  const nickel = itemById('gun.nickel-six') as CatalogItem
  it('checks sale, ownership, level and funds in that order', () => {
    expect(canBuy({ level: 5, purse: 1800 }, nickel)).toBe('ok')
    expect(canBuy({ level: 4, purse: 1800 }, nickel)).toBe('level')
    expect(canBuy({ level: 5, purse: 1799 }, nickel)).toBe('funds')
    expect(canBuy({ level: 5, purse: 1800 }, nickel, new Set(['gun.nickel-six']))).toBe('owned')
    expect(canBuy({ level: 50, purse: 1e9 }, itemById('gun.rusty-six') as CatalogItem)).toBe(
      'not_for_sale',
    )
    expect(canBuy({ level: 50, purse: 1e9 }, itemById('frame.midnight') as CatalogItem)).toBe(
      'not_for_sale',
    )
  })
})

describe('loadouts', () => {
  const owned = new Set<string>([...STARTER_ITEMS, 'hat.sombrero', 'extra.handlebar'])
  it('accepts owned items in the right slots', () => {
    expect(loadoutError(DEFAULT_LOADOUT, owned)).toBeNull()
    expect(
      loadoutError({ ...DEFAULT_LOADOUT, hat: 'hat.sombrero', extra: 'extra.handlebar' }, owned),
    ).toBeNull()
  })

  it('refuses unowned, unknown, misplaced and missing items', () => {
    expect(loadoutError({ ...DEFAULT_LOADOUT, hat: 'hat.stovepipe' }, owned)).toMatch(OWN)
    expect(loadoutError({ ...DEFAULT_LOADOUT, hat: 'hat.nope' }, owned)).toMatch(UNKNOWN)
    expect(loadoutError({ ...DEFAULT_LOADOUT, hat: 'gun.rusty-six' }, owned)).toMatch(GO_IN)
    const { gun: _, ...noGun } = DEFAULT_LOADOUT
    expect(loadoutError(noGun, owned)).not.toBeNull()
    expect(loadoutError({ ...DEFAULT_LOADOUT, cape: 'x' }, owned)).toMatch(SLOT)
    expect(loadoutError(null, owned)).not.toBeNull()
  })

  it('normalizes unknown or misplaced ids back to the starters', () => {
    expect(normalizeLoadout({ hat: 'gun.rusty-six', gun: 'gun.gilded-sovereign', x: 1 })).toEqual({
      ...DEFAULT_LOADOUT,
      gun: 'gun.gilded-sovereign',
    })
    expect(normalizeLoadout('garbage')).toEqual({ ...DEFAULT_LOADOUT })
  })
})
