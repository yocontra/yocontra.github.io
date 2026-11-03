/**
 * A Frontier player's look, from their cosmetic loadout (roster item ids): which of the ≤7 base
 * bodies they are, their top and bottom palette colours, and their hat. The same look drives the
 * near (skinned) actor and the far (VAT) instance, so a player never changes clothes when they
 * cross the LOD line. Unknown ids fall back to the starter look; a small per-player variation
 * keeps a lobby of identical starters readable.
 */
import { Color } from 'three'
import type { BodyKey, HatKey, Look } from '../../data/outlaws.ts'
import { PALETTE } from './crowd/vat.ts'

export interface PlayerLook {
  key: string
  look: Look
  hat: HatKey
  hatColor: number
  top: Color
  bottom: Color
  /** Hats read bigger in the Frontier (spec §3.8). */
  hatScale: number
}

interface OutfitStyle {
  base: BodyKey
  tops: number[]
  bottoms: number[]
  extra?: Partial<Pick<Look, 'coat' | 'poncho' | 'bandoliers'>>
}

const OUTFITS: Record<string, OutfitStyle> = {
  'outfit.trail-duds': {
    base: 'casual',
    tops: [0xd8_cc_b0, 0xb8_8a_5a, 0x9a_6a_4a, 0x8a_9a_a8],
    bottoms: [0x4a_5a_6a, 0x5a_4a_3a],
  },
  'outfit.shirt-vest': {
    base: 'worker',
    tops: [0x6a_3a_2a, 0x3a_4a_3a, 0x4a_3a_5a],
    bottoms: [0x5a_44_30, 0x3a_3a_40],
  },
  'outfit.wool-duster': {
    base: 'rugged',
    tops: [0x8a_7a_5a, 0x6a_6a_5a],
    bottoms: [0x4a_3a_2a],
    extra: { coat: 0x7a_5a_3a },
  },
  'outfit.striped-poncho': {
    base: 'rugged',
    tops: [0x8a_3a_22, 0x2e_4a_3a],
    bottoms: [0x5a_44_30],
    extra: { poncho: 0xb8_5a_2a },
  },
  'outfit.gamblers-frock': { base: 'suit', tops: [0x2a_2a_3a, 0x4a_1f_24], bottoms: [0x2a_2a_30] },
  'outfit.bandolier-rig': {
    base: 'rugged',
    tops: [0x6a_5a_3a, 0x4a_5a_4a],
    bottoms: [0x3a_30_28],
    extra: { bandoliers: true },
  },
  'outfit.undertakers-black': { base: 'suit', tops: [0x18_16_16], bottoms: [0x18_16_16] },
}
const STARTER = OUTFITS['outfit.trail-duds'] as OutfitStyle

const HATS: Record<string, { hat: HatKey; colors: number[] }> = {
  'hat.battered-brim': { hat: 'cowboy', colors: [0x6a_4a_2e, 0x8a_6a_44, 0x4a_3a_2a] },
  'hat.plainsman': { hat: 'flat', colors: [0xb5_9a_6a, 0x8a_7a_5a] },
  'hat.sombrero': { hat: 'sombrero', colors: [0xc8_a8_6a] },
  'hat.stovepipe': { hat: 'tophat', colors: [0x1e_1a_18] },
  'hat.rattler-band': { hat: 'tall', colors: [0x3a_2e_22] },
  'hat.ghost-white': { hat: 'cowboy', colors: [0xee_ea_e0] },
  'hat.yellow': { hat: 'cowboy', colors: [0xe8_c0_30] },
}
const STARTER_HAT = HATS['hat.battered-brim'] as { hat: HatKey; colors: number[] }

const pick = <T>(list: readonly T[], n: number, fallback: T): T => list[n % list.length] ?? fallback

export function lookFor(loadout: readonly string[], id: number): PlayerLook {
  const outfitId = loadout.find((i) => i.startsWith('outfit.')) ?? 'outfit.trail-duds'
  const hatId = loadout.find((i) => i.startsWith('hat.')) ?? 'hat.battered-brim'
  const o = OUTFITS[outfitId] ?? STARTER
  const h = HATS[hatId] ?? STARTER_HAT
  const v = (id * 2_654_435_761) >>> 0
  const top = pick(o.tops, v, 0x80_80_80)
  const bottom = pick(o.bottoms, v >>> 4, 0x40_40_40)
  const hatColor = pick(h.colors, v >>> 8, 0x5a_40_2a)
  const [topMats, bottomMats] = PALETTE[o.base]
  const tint: Record<string, number> = {}
  for (const m of topMats) {
    tint[m] = top
  }
  for (const m of bottomMats) {
    tint[m] = bottom
  }
  const look: Look = { base: o.base, tint, scale: 1, ...o.extra }
  return {
    key: `${outfitId}/${hatId}/${top}/${bottom}/${hatColor}`,
    look,
    hat: h.hat,
    hatColor,
    top: new Color(top),
    bottom: new Color(bottom),
    hatScale: 1.15,
  }
}
