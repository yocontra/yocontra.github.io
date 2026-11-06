import { describe, expect, it } from 'bun:test'
import {
  CATALOG,
  DEFAULT_LOADOUT,
  isItemId,
  itemById,
  STARTER_ITEMS,
} from '../src/experiments/out-west/data/catalog.ts'

describe('the Outfitter catalogue', () => {
  it('has unique item ids', () => {
    const ids = CATALOG.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every default loadout slot names a real item of that slot', () => {
    const slots = [
      'gun',
      'hat',
      'outfit',
      'spurs',
      'holster',
      'frame',
      'drawSound',
      'saddlebag',
    ] as const
    for (const slot of slots) {
      const id = DEFAULT_LOADOUT[slot]
      expect(isItemId(id)).toBe(true)
      expect(itemById(id)?.slot).toBe(slot)
    }
  })

  it('the starter set is exactly the free starter items', () => {
    const starters = CATALOG.filter((item) => item.source === 'starter').map((item) => item.id)
    expect([...STARTER_ITEMS]).toEqual(starters)
  })

  it('priced items have a price and a level gate', () => {
    for (const item of CATALOG.filter((i) => i.source === 'store')) {
      expect(item.price).toBeGreaterThan(0)
      expect(item.level).toBeGreaterThanOrEqual(1)
    }
  })

  it('free items have no price', () => {
    for (const item of CATALOG.filter((i) => i.source !== 'store')) {
      expect(item.price).toBe(0)
      expect(item.level).toBe(1)
    }
  })
})
