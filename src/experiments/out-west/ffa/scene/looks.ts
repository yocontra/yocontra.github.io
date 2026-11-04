/**
 * A Frontier player's look, from their cosmetic loadout (roster item ids): which of the ≤7 base
 * bodies they are, their top and bottom palette colours, and their hat. The same look drives the
 * near (skinned) actor and the far (VAT) instance, so a player never changes clothes when they
 * cross the LOD line. Unknown ids fall back to the starter look; a small per-player variation
 * keeps a lobby of identical starters readable: the palette colours, and the rider's own skin tone
 * and hair colour (the same for near and far: the VAT recolours skin and hair per instance too).
 */
import { Color } from 'three'
import type { BodyKey, HatKey, Look, MoustacheKey, SkinKey } from '../../data/outlaws.ts'
import { HAIR_COLORS, SKINS, seeded } from '../../scene/identity.ts'
import { HAIR_LUM, SKIN_TONES } from '../../scene/person.ts'
import { PALETTE } from './crowd/vat.ts'

export interface PlayerLook {
  key: string
  look: Look
  hat: HatKey
  hatColor: number
  top: Color
  bottom: Color
  /** Hair tint as the shader takes it (the colour over the grey hair texels). */
  hair: Color
  /** Skin tone multiplier on the atlas skin. */
  skin: Color
  /**
   * Extra hat scale in the Frontier. 1: every hat is fitted snug to its head (scene/hats.ts); a
   * bigger one sits loose and floats above the skull (spec §3.8 asked for 1.15, which read as
   * hats far too large).
   */
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
    tops: [0xd8_cc_b0, 0x8a_3a_2a, 0x4a_5a_6a, 0x8a_9a_a8],
    bottoms: [0x4a_5a_6a, 0x5a_4a_3a],
  },
  'outfit.shirt-vest': {
    base: 'worker',
    tops: [0x6a_3a_2a, 0x3a_4a_3a, 0x4a_3a_5a],
    bottoms: [0x5a_44_30, 0x3a_3a_40],
  },
  'outfit.wool-duster': {
    base: 'rugged',
    tops: [0x6a_6a_5a, 0x5a_4a_3a],
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
  'outfit.midnight-coat': { base: 'suit', tops: [0x1a_1a_2e], bottoms: [0x1a_1a_24] },
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
  'hat.bronze-band': { hat: 'cowboy', colors: [0x8a_5a_30] },
  'hat.holed-stetson': { hat: 'cowboy', colors: [0x6a_58_44] },
}
const STARTER_HAT = HATS['hat.battered-brim'] as { hat: HatKey; colors: number[] }

const pick = <T>(list: readonly T[], n: number, fallback: T): T => list[n % list.length] ?? fallback

/** Period shirts beyond an outfit's own few: muslin, chambray, madder, indigo, ochre, sage, slate. */
const SHIRTS: readonly number[] = [
  0xd8_cc_b0, 0xc8_b8_98, 0x8a_3a_2a, 0x6e_2a_22, 0x4a_5a_6a, 0x8a_9a_a8, 0x2e_3a_52, 0xb0_8a_44,
  0x6a_7a_5a, 0x5a_5e_66, 0xe2_dc_cc, 0x7a_4a_5a,
]
/** Trousers: denim, browns, greys, black. */
const PANTS: readonly number[] = [
  0x32_38_46, 0x4a_3a_2a, 0x5a_4a_38, 0x4a_46_40, 0x2a_24_1e, 0x5e_52_3e,
]
const BOOTS: readonly number[] = [0x7a_5a_38, 0x3a_26_18, 0x16_12_10, 0x4a_24_20, 0x5a_50_48]
const VESTS: readonly number[] = [0x3a_2a_1e, 0x2a_2a_30, 0x5a_3a_22, 0x4a_42_36, 0x6a_2a_22]
const MOUSTACHES: readonly MoustacheKey[] = [
  'handlebar',
  'walrus',
  'pencil',
  'horseshoe',
  'chevron',
]
const OUTFIT_IDS = Object.keys(OUTFITS)
const HAT_IDS = Object.keys(HATS)

/**
 * The man under the kit, from his rider id (the same on every screen): facial hair, stubble,
 * build, face and stance. Near riders wear all of it; the far crowd keeps his colours.
 */
function identity(r: () => number, hairHex: number, skin: SkinKey): Partial<Look> {
  const range = (lo: number, hi: number) => lo + (hi - lo) * r()
  const who: Partial<Look> = {
    stubble: r() < 0.45 ? range(0.3, 0.85) : 0,
    build: {
      head: range(0.95, 1.05),
      neck: range(0.92, 1.08),
      shoulders: range(0.93, 1.09),
      chest: range(0.93, 1.09),
      belly: r() < 0.3 ? range(1.06, 1.18) : range(0.93, 1.03),
    },
    face: { jaw: range(-0.08, 0.1), long: range(-0.04, 0.08) },
    stance: { tilt: range(-0.08, 0.08), chin: range(-0.06, 0.08), hip: range(-0.06, 0.06) },
  }
  const whiskers = r()
  if (whiskers < 0.5) {
    who.moustache = hairHex
    who.moustacheStyle = MOUSTACHES[Math.floor(r() * MOUSTACHES.length)] ?? 'chevron'
  }
  if (whiskers > 0.38 && whiskers < 0.66) {
    who.beard = hairHex
    who.beardStyle = r() < 0.5 ? 'full' : 'goatee'
  } else if (whiskers >= 0.86) {
    who.sideburns = hairHex
  }
  if (skin === 'tan' && who.moustache === undefined && who.beard === undefined) {
    // never the player's own bare atlas face
    who.stubble = Math.max(who.stubble ?? 0, 0.6)
  }
  return who
}

/**
 * A rider's look. His loadout decides the outfit and hat he paid for; a starter (and every bot)
 * still gets a face of his own, and his shirt and trousers from the wider period palette, all
 * seeded by his rider id so he looks the same to everyone. Bots, who own nothing, also wear the
 * town's whole wardrobe (coats, ponchos, vests, frocks, other hats): a lobby of bots shouldn't be
 * a lobby of clones.
 */
export function lookFor(loadout: readonly string[], id: number, bot = false): PlayerLook {
  const r = seeded(`ow-rider/${id}`)
  const ownOutfit = loadout.find((i) => i.startsWith('outfit.'))
  const ownHat = loadout.find((i) => i.startsWith('hat.'))
  const outfitId = bot
    ? (OUTFIT_IDS[Math.floor(r() * OUTFIT_IDS.length)] ?? 'outfit.trail-duds')
    : (ownOutfit ?? 'outfit.trail-duds')
  const hatId = bot
    ? (HAT_IDS[Math.floor(r() * HAT_IDS.length)] ?? 'hat.battered-brim')
    : (ownHat ?? 'hat.battered-brim')
  const o = OUTFITS[outfitId] ?? STARTER
  const h = HATS[hatId] ?? STARTER_HAT
  const starter = outfitId === 'outfit.trail-duds'
  const v = (id * 2_654_435_761) >>> 0
  // a starter's shirt and trousers come from the period palette; a bought outfit keeps its own
  const top = starter
    ? pick(SHIRTS, Math.floor(r() * SHIRTS.length), 0xd8_cc_b0)
    : pick(o.tops, v, 0x80_80_80)
  const bottom = starter
    ? pick(PANTS, Math.floor(r() * PANTS.length), 0x4a_3a_2a)
    : pick(o.bottoms, v >>> 4, 0x40_40_40)
  const hatColor = pick(h.colors, Math.floor(r() * 7), 0x5a_40_2a)
  const [topMats, bottomMats] = PALETTE[o.base]
  const tint: Record<string, number> = {}
  for (const m of topMats) {
    tint[m] = top
  }
  for (const m of bottomMats) {
    tint[m] = bottom
  }
  const skin = SKINS[Math.floor(r() * SKINS.length)] ?? 'tan'
  const old = r() < 0.18
  const hairHex = old
    ? pick(HAIR_COLORS, 6 + Math.floor(r() * 2), 0x7e_76_6c)
    : pick(HAIR_COLORS, Math.floor(r() * 6), 0x2e_1e_12)
  tint.Hair = hairHex
  tint.Boots = pick(BOOTS, Math.floor(r() * BOOTS.length), 0x3a_26_18)
  const who = identity(r, hairHex, skin)
  // a bot in plain duds often throws a waistcoat over the shirt
  const vest =
    bot && starter && r() < 0.45
      ? pick(VESTS, Math.floor(r() * VESTS.length), 0x3a_2a_1e)
      : undefined
  const tone = SKIN_TONES[skin] ?? SKIN_TONES.tan
  const look: Look = {
    base: o.base,
    tint,
    scale: 1,
    skin,
    ...o.extra,
    ...who,
    ...(vest === undefined ? {} : { vest }),
  }
  return {
    key: `rider/${id}/${outfitId}/${hatId}/${top}/${bottom}/${hatColor}/${skin}/${hairHex}`,
    look,
    hat: h.hat,
    hatColor,
    top: new Color(top),
    bottom: new Color(bottom),
    hair: new Color(hairHex).multiplyScalar(1 / HAIR_LUM),
    skin: new Color(tone[0], tone[1], tone[2]),
    hatScale: 1,
  }
}
