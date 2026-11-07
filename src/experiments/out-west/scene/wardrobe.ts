/** Catalog garment appearance shared by duels, the Outfitter and Frontier. */
import type { ItemId } from '../data/catalog.ts'
import type { CoatCut } from '../data/outlaws.ts'

export interface OutfitLook {
  coat?: number
  coatCut?: CoatCut
  poncho?: number
  bandoliers?: boolean
  /** A waistcoat over the shirt. */
  vest?: number
  /** A neckerchief (the extra slot's bandana, when one is worn, replaces it). */
  bandana?: number
  /** Garment of the player base (Shirt, Sleeves, Pants, Boots...) → colour. */
  tint?: Readonly<Record<string, number>>
}

export const OUTFITS: Partial<Record<ItemId, OutfitLook>> = {
  'outfit.midnight-coat': { coat: 0x1a_1a_2e, tint: { Shirt: 0x2a_2a_3a, Pants: 0x1a_1a_24 } },
  /**
   * The starter reads as a gunslinger at 64 px, front and back: a near-black waistcoat over a faded
   * chambray shirt, an oxblood neckerchief, dark wool trousers and dark boots, the gunbelt on top.
   * Kept well apart from outlaws 1–3 (dun, blue-grey and russet coats and shirts).
   */
  'outfit.trail-duds': {
    vest: 0x24_1c_18,
    bandana: 0x7a_1e_16,
    tint: { Shirt: 0x6a_74_7e, Sleeves: 0x6a_74_7e, Pants: 0x2e_2a_28, Boots: 0x22_18_12 },
  },
  'outfit.shirt-vest': { vest: 0x3a_2a_1e, tint: { Shirt: 0xd8_cc_b0, Sleeves: 0xd8_cc_b0 } },
  'outfit.wool-duster': { coat: 0x6a_50_38 },
  'outfit.striped-poncho': { poncho: 0x9a_3a_28 },
  'outfit.gamblers-frock': {
    coat: 0x2a_1c_2e,
    coatCut: 'frock',
    tint: { Shirt: 0xe8_e0_d0, Pants: 0x2a_22_2a },
  },
  'outfit.bandolier-rig': { bandoliers: true, tint: { Shirt: 0x8a_6a_4a, Sleeves: 0x6a_50_38 } },
  'outfit.undertakers-black': {
    coat: 0x12_10_10,
    coatCut: 'frock',
    tint: { Shirt: 0x1e_1a_1a, Sleeves: 0x1a_16_14, Pants: 0x14_12_10, Boots: 0x14_12_10 },
  },
}
