/**
 * Money bags on the Frontier street: what the client knows of one, and its look. A death drops a
 * bag in the victim's saddlebag cosmetic (spec §7): plain sack, branded satchel or gold thread.
 */

export interface Bag {
  id: number
  x: number
  z: number
  amount: number
  born: number
  /** Exclusive to you (the killer) for its first seconds. */
  mine: boolean
  /** The dropper's saddlebag colour (the plain sack's when unknown). */
  color?: number
}

/** The bag a player drops, by their saddlebag cosmetic (spec §7): its colour on the street. */
const BAG_COLORS: Readonly<Record<string, number>> = {
  'bag.plain-sack': 0xb8_9a_60,
  'bag.branded-satchel': 0x7a_4a_26,
  'bag.gold-thread': 0xd8_b0_48,
}

export const PLAIN_BAG = 0xb8_9a_60

/** The colour of the money bag this loadout drops (the plain sack when it has none). */
export function bagColor(loadout: readonly string[]): number {
  const id = loadout.find((i) => i.startsWith('bag.'))
  return (id ? BAG_COLORS[id] : undefined) ?? PLAIN_BAG
}
