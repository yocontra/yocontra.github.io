/**
 * Catalog cosmetics on a character. A loadout (eight item ids) becomes the existing actor options
 * (hat, coat, poncho, bandana, moustache, star, bandoliers, holster, tints) so every piece is fitted to the
 * body and baked into the one skinned mesh as before. Two finishing touches ride on bones: the gun
 * finish (a tint on the merged revolver) and the spur rowels on the boot heels.
 *
 * Pure presentation: nothing here changes a timing, a clip length, the muzzle or the hit capsule.
 * An unknown id falls back to the starter for its slot (`normalizeLoadout`).
 */
import {
  Bone,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { type ItemId, type Loadout, normalizeLoadout } from '../data/catalog.ts'
import type { HatKey } from '../data/outlaws.ts'
import { type Dyes, dyeHex } from '../net/wire-social.ts'
import { Actor, type ActorOpts } from './actor.ts'
import type { HolsterLook } from './kit.ts'
import { type PropDef, propObject } from './props.ts'

interface HatLook {
  key: HatKey
  color: number
}

interface OutfitLook {
  coat?: number
  poncho?: number
  bandoliers?: boolean
  /** Garment of the player base (Shirt, Sleeves, Pants, Boots...) → colour. */
  tint?: Readonly<Record<string, number>>
}

interface GunLook {
  color: number
  metalness: number
  roughness: number
  /** Barrel length factor (looks only; the muzzle point scales with it). */
  length: number
  twin?: boolean
}

const HATS: Partial<Record<ItemId, HatLook>> = {
  'hat.battered-brim': { key: 'cowboy', color: 0x5a_42_2e },
  'hat.plainsman': { key: 'flat', color: 0x8a_70_50 },
  'hat.sombrero': { key: 'sombrero', color: 0xc8_a0_60 },
  'hat.stovepipe': { key: 'tophat', color: 0x1a_14_10 },
  'hat.rattler-band': { key: 'tall', color: 0x4a_3a_24 },
  'hat.ghost-white': { key: 'cowboy', color: 0xee_e8_da },
  'hat.yellow': { key: 'cowboy', color: 0xe8_c8_20 },
}

const OUTFITS: Partial<Record<ItemId, OutfitLook>> = {
  'outfit.trail-duds': {},
  'outfit.shirt-vest': { tint: { Shirt: 0xd8_cc_b0, Sleeves: 0x3a_2a_1e } },
  'outfit.wool-duster': { coat: 0x6a_50_38 },
  'outfit.striped-poncho': { poncho: 0x9a_3a_28 },
  'outfit.gamblers-frock': { coat: 0x2a_1c_2e, tint: { Shirt: 0xe8_e0_d0, Pants: 0x2a_22_2a } },
  'outfit.bandolier-rig': { bandoliers: true, tint: { Shirt: 0x8a_6a_4a, Sleeves: 0x6a_50_38 } },
  'outfit.undertakers-black': {
    coat: 0x12_10_10,
    tint: { Shirt: 0x1e_1a_1a, Sleeves: 0x1a_16_14, Pants: 0x14_12_10, Boots: 0x14_12_10 },
  },
}

const GUNS: Partial<Record<ItemId, GunLook>> = {
  'gun.rusty-six': { color: 0x9a_7a_66, metalness: 0.3, roughness: 0.7, length: 1 },
  'gun.blued-six': { color: 0x6a_80_a8, metalness: 0.7, roughness: 0.35, length: 1 },
  'gun.nickel-six': { color: 0xe0_e4_ea, metalness: 0.9, roughness: 0.22, length: 1 },
  'gun.engraved-ivory': { color: 0xf4_ea_d4, metalness: 0.6, roughness: 0.3, length: 1 },
  'gun.buntline': { color: 0xb8_bc_c4, metalness: 0.8, roughness: 0.3, length: 1.3 },
  'gun.gilded-sovereign': { color: 0xff_c8_50, metalness: 1, roughness: 0.18, length: 1 },
  'gun.hardins-pair': {
    color: 0xd0_d0_d8,
    metalness: 0.85,
    roughness: 0.25,
    length: 1,
    twin: true,
  },
}

const SPURS: Partial<Record<ItemId, { color: number; points: number; metalness: number }>> = {
  'spurs.plain-rowels': { color: 0x6a_60_58, points: 8, metalness: 0.5 },
  'spurs.silver-jinglebobs': { color: 0xe6_e8_ee, points: 10, metalness: 0.95 },
  'spurs.star-rowels': { color: 0xf0_c8_60, points: 5, metalness: 1 },
}

/** Holster leather, baked on the thigh like the plain one (the gun's slot never moves). */
const HOLSTERS: Partial<Record<ItemId, HolsterLook>> = {
  'holster.plain-leather': { color: 0x3a_24_14, roughness: 0.55 },
  'holster.tooled-floral': { color: 0x8a_5a_30, roughness: 0.45, trim: 0xd8_b0_70 },
  'holster.buscadero': { color: 0x2a_18_10, roughness: 0.4, trim: 0xc8_c8_d0, rig: true },
}

/**
 * Frame colours for the duel posters (ui/results, the match intro). Keyed by id string: the dated
 * Most Wanted frame is a server-granted reward the catalog may not list yet.
 */
export const FRAME_COLORS: Readonly<Record<string, string>> = {
  'frame.pine-board': '#8a6a42',
  'frame.brass-tacks': '#c8a04a',
  'frame.gilt-saloon': '#e8c060',
  'frame.most-wanted-gilt': '#ffd870',
  'frame.midnight': '#2a2a40',
  'frame.most-wanted-dated': '#d8b45a',
}

/** Draw-sound layers on your own shot: [sfx rate, gain]. The standard report adds nothing. */
export const DRAW_SOUNDS: Partial<Record<ItemId, { rate: number; gain: number; hawk?: boolean }>> =
  {
    'sound.thunder-crack': { rate: 1.25, gain: 0.7 },
    'sound.cannon-boom': { rate: 0.62, gain: 0.9 },
    'sound.thunderclap-hawk': { rate: 0.8, gain: 0.9, hawk: true },
  }

const EXTRAS: Partial<Record<ItemId, Partial<ActorOpts>>> = {
  'extra.handlebar': { moustache: 0x3a_24_14 },
  'extra.red-bandana': { bandana: 0x9a_1a_14 },
  'extra.tin-star': { star: true },
}

/** An outfit recoloured by its dye: the coat or poncho takes it, else the shirt and sleeves. */
function dyedOutfit(outfit: OutfitLook, hex: number | null): OutfitLook {
  if (hex === null) {
    return outfit
  }
  if (outfit.coat !== undefined) {
    return { ...outfit, coat: hex }
  }
  if (outfit.poncho !== undefined) {
    return { ...outfit, poncho: hex }
  }
  return { ...outfit, tint: { ...outfit.tint, Shirt: hex, Sleeves: hex } }
}

/** An extra recoloured by its dye (the bandana's cloth, the moustache); the tin star stays tin. */
function dyedExtra(extra: Partial<ActorOpts>, hex: number | null): Partial<ActorOpts> {
  if (hex === null) {
    return extra
  }
  if (extra.bandana !== undefined) {
    return { ...extra, bandana: hex }
  }
  if (extra.moustache !== undefined) {
    return { ...extra, moustache: hex }
  }
  return extra
}

/**
 * Actor options for a loadout and its dye jobs (the gun is added by `dressedActor`). A dye is a
 * tint over cloth and leather only: never a mesh, a sound or a silhouette.
 */
export function loadoutOpts(raw: unknown, dyes: Dyes = {}): ActorOpts {
  const l = normalizeLoadout(raw)
  const hat = HATS[l.hat] ?? HATS['hat.battered-brim']
  const outfit = dyedOutfit(OUTFITS[l.outfit] ?? {}, dyeHex(dyes[l.outfit]))
  const extra = l.extra ? dyedExtra(EXTRAS[l.extra] ?? {}, dyeHex(dyes[l.extra])) : {}
  const holster = HOLSTERS[l.holster] ?? HOLSTERS['holster.plain-leather']
  const holsterDye = dyeHex(dyes[l.holster])
  const o: ActorOpts = {
    hat: hat?.key ?? 'cowboy',
    hatColor: dyeHex(dyes[l.hat]) ?? hat?.color ?? 0x5a_42_2e,
    tint: outfit.tint ?? {},
    seed: `loadout/${l.hat}/${l.outfit}/${l.extra ?? ''}`,
    holster: holster && holsterDye !== null ? { ...holster, color: holsterDye } : holster,
    ...extra,
  }
  if (outfit.coat !== undefined) {
    o.coat = outfit.coat
  }
  if (outfit.poncho !== undefined) {
    o.poncho = outfit.poncho
  }
  if (outfit.bandoliers) {
    o.bandoliers = true
  }
  return o
}

/** Tint the merged revolver(s) in place: one cloned material per gun. */
function finishGun(g: Object3D | null, look: GunLook): void {
  g?.traverse((m) => {
    if (!(m instanceof Mesh)) {
      return
    }
    const src = m.material as MeshStandardMaterial
    const mat = src.clone()
    mat.color.setHex(look.color)
    mat.metalness = look.metalness
    mat.roughness = look.roughness
    m.material = mat
    // revolver geometry points +X: a longer barrel is a stretch along it
    m.scale.x *= look.length
  })
}

const norm = (name: string): string => name.replace(/[^a-z]/giu, '').toLowerCase()

/** A rowel on each boot heel, riding the foot bone. */
function fitSpurs(a: Actor, look: { color: number; points: number; metalness: number }): void {
  const feet: Bone[] = []
  a.model.traverse((b) => {
    if (b instanceof Bone && (norm(b.name) === 'footl' || norm(b.name) === 'footr')) {
      feet.push(b)
    }
  })
  a.root.updateMatrixWorld(true)
  const rootQ = a.root.getWorldQuaternion(new Quaternion())
  const back = new Vector3(0, 0, -1).applyQuaternion(rootQ)
  const mat = new MeshStandardMaterial({
    color: look.color,
    metalness: look.metalness,
    roughness: 0.3,
  })
  const geo = new CylinderGeometry(0.028, 0.028, 0.006, look.points)
  for (const foot of feet) {
    const rowel = new Mesh(geo, mat)
    const p = foot.getWorldPosition(new Vector3())
    rowel.position
      .copy(p)
      .addScaledVector(back, 0.07)
      .setY(Math.max(0.05, p.y - 0.02))
    rowel.quaternion
      .copy(rootQ)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2))
    rowel.castShadow = true
    a.root.add(rowel)
    foot.attach(rowel)
  }
}

/**
 * A whole gunslinger dressed in `loadout`, on the player's rig. Used for you (single player and
 * Bounty Hunt) and for your opponent, built from their server-validated loadout.
 */
export function dressedActor(
  model: GLTF,
  gun: PropDef | null,
  raw: unknown,
  dyes: Dyes = {},
): Actor {
  const l: Loadout = normalizeLoadout(raw)
  const gunLook = GUNS[l.gun] ?? GUNS['gun.rusty-six']
  const a = new Actor(model, {
    ...loadoutOpts(l, dyes),
    gun: gun ? propObject(gun) : null,
    offGun: gunLook?.twin ?? false,
  })
  if (gunLook) {
    finishGun(a.gun, gunLook)
    finishGun(a.offGun, gunLook)
  }
  const spurs = SPURS[l.spurs]
  if (spurs) {
    fitSpurs(a, spurs)
  }
  return a
}
