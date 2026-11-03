// biome-ignore-all lint/style/useNamingConvention: tint keys mirror the base GLB's material names (Pants, Boots, Hair)
/**
 * A stranger's face, from his name. Bounty Hunt opponents and ghosts wear their own loadout, but
 * a loadout says nothing about the man under it: two starters in trail duds were the same man.
 * So each opponent gets a deterministic identity from his public name (the same on every screen
 * and every rematch): skin, hair cut and colour, facial hair, build, face shape, a standing habit,
 * and the trousers and boots under whatever his outfit recolours.
 *
 * It never matches the player's own (the base as built: atlas skin, the base's dark brown hair,
 * clean shaven), so two duellists can't look identical.
 */
import type { BodyKey, HairKey, MoustacheKey, SkinKey } from '../data/outlaws.ts'
import type { Assets } from '../engine/assets.ts'
import { hairDonor, type PersonOpts } from './person.ts'

/** Who he is under the kit (actor options) plus the colours his kit leaves to him. */
export type Identity = PersonOpts & {
  tint?: Readonly<Record<string, number>>
  moustache?: number | undefined
  beard?: number | undefined
}

/** Believable skin tones, palest to darkest. */
export const SKINS: readonly SkinKey[] = ['pale', 'fair', 'ruddy', 'tan', 'olive', 'brown', 'dark']

/** Hair colours: black, browns, chestnut, ginger, sandy, then grey with age. */
export const HAIR_COLORS: readonly number[] = [
  0x14_10_0c, 0x2e_1e_12, 0x4a_2e_18, 0x6a_42_24, 0x8a_4e_24, 0xb8_8a_50, 0x7e_76_6c, 0xa8_a0_94,
]

/** Period trousers: denim, browns, greys, black. */
const PANTS: readonly number[] = [
  0x32_38_46, 0x4a_3a_2a, 0x5a_4a_38, 0x4a_46_40, 0x2a_24_1e, 0x5e_52_3e,
]
const BOOTS: readonly number[] = [0x7a_5a_38, 0x3a_26_18, 0x16_12_10, 0x4a_24_20, 0x5a_50_48]
const MOUSTACHES: readonly MoustacheKey[] = [
  'handlebar',
  'walrus',
  'pencil',
  'horseshoe',
  'chevron',
]
const CUTS: readonly HairKey[] = ['short', 'short', 'crop', 'crop', 'long', 'bald']

/** A seeded stream of 0..1 from a string (FNV-1a, then xorshift). */
export function seeded(text: string): () => number {
  let h = 0x81_1c_9d_c5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01_00_01_93)
  }
  let s = h >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4_294_967_296
  }
}

const pick = <T>(r: () => number, list: readonly T[], fallback: T): T =>
  list[Math.floor(r() * list.length)] ?? fallback
const range = (r: () => number, lo: number, hi: number): number => lo + (hi - lo) * r()

/**
 * The identity for `name` on `base`. A borrowed hair cut needs its donor base loaded: when it
 * isn't (yet), he keeps the base's cut and the load is started for next time.
 */
export function identityFor(name: string, assets: Assets, base: BodyKey = 'casual'): Identity {
  const r = seeded(`ow-identity/${name.trim().toLowerCase()}`)
  const skin = pick(r, SKINS, 'fair')
  const old = r() < 0.2
  const hairColor = old
    ? pick(r, HAIR_COLORS.slice(6), 0x7e_76_6c)
    : pick(r, HAIR_COLORS.slice(0, 6), 0x2e_1e_12)
  let hair: HairKey = pick(r, CUTS, 'short')
  const donor = hairDonor(base, hair)
  const donorModel = donor ? assets.bodyNow(donor) : null
  if (donor && !donorModel) {
    assets.body(donor).catch(() => undefined)
    hair = 'short'
  }
  const whiskers = r()
  const who: Identity = {
    skin,
    hair,
    hairFrom: donorModel,
    tint: { Hair: hairColor, Pants: pick(r, PANTS, 0x4a_3a_2a), Boots: pick(r, BOOTS, 0x3a_26_18) },
    stubble: r() < 0.45 ? range(r, 0.3, 0.85) : 0,
    build: {
      head: range(r, 0.94, 1.06),
      neck: range(r, 0.9, 1.1),
      shoulders: range(r, 0.92, 1.1),
      chest: range(r, 0.92, 1.1),
      belly: r() < 0.3 ? range(r, 1.06, 1.2) : range(r, 0.92, 1.04),
    },
    face: { jaw: range(r, -0.08, 0.1), long: range(r, -0.04, 0.08) },
    stance: { tilt: range(r, -0.1, 0.1), chin: range(r, -0.08, 0.1), hip: range(r, -0.08, 0.08) },
  }
  // whiskers: most men wear some; a clean-shaven one is told apart by his skin or hair instead
  if (whiskers < 0.55) {
    who.moustache = hairColor
    who.moustacheStyle = pick(r, MOUSTACHES, 'chevron')
  }
  if (whiskers > 0.4 && whiskers < 0.7) {
    who.beard = hairColor
    who.beardStyle = r() < 0.5 ? 'sculpted' : 'goatee'
  } else if (whiskers >= 0.85) {
    who.sideburns = hairColor
  }
  // never the player's own face: the atlas skin and a bare face get at least a day's growth
  if (skin === 'tan' && who.moustache === undefined && who.beard === undefined) {
    who.stubble = Math.max(who.stubble ?? 0, 0.6)
  }
  return who
}
