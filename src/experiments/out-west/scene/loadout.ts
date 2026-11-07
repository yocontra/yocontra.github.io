/**
 * Catalog cosmetics on a character. A loadout (eight item ids) becomes the existing actor options
 * (hat, coat, poncho, bandana, moustache, star, bandoliers, holster, tints) so every piece is fitted to the
 * body and baked into the one skinned mesh as before. Two finishing touches ride on bones: the gun
 * finish (the Peacemaker built in that finish, scene/revolver.ts) and the spur rowels on the boot
 * heels.
 *
 * Pure presentation: nothing here changes a timing, a clip length, the muzzle or the hit capsule.
 * An unknown id falls back to the starter for its slot (`normalizeLoadout`).
 */
import { Bone, Group, Mesh, MeshStandardMaterial, type Object3D, Quaternion, Vector3 } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { type ItemId, itemById, type Loadout, normalizeLoadout } from '../data/catalog.ts'
import { type Dyes, dyeHex } from '../data/dye.ts'
import type { HatKey } from '../data/outlaws.ts'
import { Actor, type ActorOpts } from './actor.ts'
import { BLUED, BRASS, CASE, type Finish, NICKEL, WALNUT } from './gunsmith.ts'
import { hatDetailFor } from './hat-detail.ts'
import type { Identity } from './identity.ts'
import type { HolsterLook } from './kit.ts'
import type { PropDef } from './props.ts'
import { PEACEMAKER, type RevolverLook, revolverObject } from './revolver.ts'
import { markFlat } from './roles.ts'
import { spurGeometry } from './spurs.ts'
import { OUTFITS, type OutfitLook } from './wardrobe.ts'

interface HatLook {
  key: HatKey
  color: number
}

interface GunLook {
  /** The Peacemaker's finish and barrel (looks only: the muzzle is measured where it is). */
  finish: RevolverLook
  twin?: boolean
}

const HATS: Partial<Record<ItemId, HatLook>> = {
  // the starter: a dark, sweat-stained cattleman's crown, not a farmhand's straw-brown
  'hat.battered-brim': { key: 'cowboy', color: 0x3a_2c_22 },
  'hat.plainsman': { key: 'flat', color: 0x8a_70_50 },
  'hat.sombrero': { key: 'sombrero', color: 0xc8_a0_60 },
  'hat.stovepipe': { key: 'tophat', color: 0x1a_14_10 },
  'hat.rattler-band': { key: 'tall', color: 0x4a_3a_24 },
  'hat.ghost-white': { key: 'cowboy', color: 0xee_e8_da },
  'hat.yellow': { key: 'cowboy', color: 0xe8_c8_20 },
  'hat.bronze-band': { key: 'cowboy', color: 0x8a_5a_30 },
  'hat.holed-stetson': { key: 'cowboy', color: 0x6a_58_44 },
}

const finish = (f: Finish, rgb: Finish['rgb'], metal: number, rough: number): Finish => ({
  band: f.band,
  rgb,
  metal,
  rough,
})
/** Gilt: brass's band, brightened toward gold leaf. */
const GILT = finish(BRASS, [1.12, 1.0, 0.78], 1, 0.2)
/** Ivory grips: the white band, warm, a soft sheen. */
const IVORY = finish(NICKEL, [0.98, 0.92, 0.8], 0, 0.36)
/** Silver plate: cooler and brighter than nickel. */
const SILVER = finish(NICKEL, [0.9, 0.92, 0.96], 1, 0.18)

const GUNS: Partial<Record<ItemId, GunLook>> = {
  // the starter: a working gun gone brown, its case colours faded, its walnut dry
  'gun.rusty-six': {
    finish: {
      barrel: 5.5,
      steel: finish(BLUED, [1.45, 1.1, 0.86], 0.55, 0.6),
      frame: finish(CASE, [1.02, 0.9, 0.78], 0.5, 0.62),
      guard: finish(BRASS, [0.72, 0.62, 0.48], 0.85, 0.55),
      grip: finish(WALNUT, [0.88, 0.84, 0.8], 0, 0.7),
    },
  },
  'gun.blued-six': { finish: PEACEMAKER },
  'gun.nickel-six': {
    finish: { barrel: 5.5, steel: NICKEL, frame: NICKEL, guard: NICKEL, grip: WALNUT },
  },
  'gun.engraved-ivory': {
    finish: { barrel: 5.5, steel: NICKEL, frame: NICKEL, guard: GILT, grip: IVORY, engraved: true },
  },
  'gun.buntline': { finish: { ...PEACEMAKER, barrel: 12 } },
  'gun.gilded-sovereign': {
    finish: { barrel: 5.5, steel: GILT, frame: GILT, guard: GILT, grip: IVORY },
  },
  'gun.gold-medal': {
    finish: { barrel: 5.5, steel: BLUED, frame: GILT, guard: GILT, grip: WALNUT },
  },
  'gun.hardins-pair': {
    finish: { barrel: 5.5, steel: SILVER, frame: SILVER, guard: SILVER, grip: IVORY },
    twin: true,
  },
}

const SPURS: Partial<Record<ItemId, { color: number; points: number; metalness: number }>> = {
  'spurs.plain-rowels': { color: 0x6a_60_58, points: 8, metalness: 0.5 },
  'spurs.silver-jinglebobs': { color: 0xe6_e8_ee, points: 10, metalness: 0.95 },
  'spurs.star-rowels': { color: 0xf0_c8_60, points: 5, metalness: 1 },
  'spurs.legend-rowels': { color: 0x2a_2a_30, points: 6, metalness: 0.9 },
}

/** Holster leather, baked on the thigh like the plain one (the gun's slot never moves). */
const HOLSTERS: Partial<Record<ItemId, HolsterLook>> = {
  'holster.plain-leather': { color: 0x3a_24_14, roughness: 0.55 },
  'holster.tooled-floral': {
    color: 0x8a_5a_30,
    roughness: 0.45,
    trim: 0xd8_b0_70,
    detail: 'floral',
  },
  'holster.buscadero': { color: 0x2a_18_10, roughness: 0.4, trim: 0xc8_c8_d0, rig: true },
  'holster.silver-conchos': {
    color: 0x2a_18_10,
    roughness: 0.45,
    trim: 0xd8_dc_e4,
    detail: 'conchos',
  },
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
  'frame.tall-tales': '#7a2a1e',
  'frame.legend': '#2a4a32',
}

/** Draw-sound layers on your own shot: [sfx rate, gain]. The standard report adds nothing. */
export const DRAW_SOUNDS: Partial<Record<ItemId, { rate: number; gain: number; hawk?: boolean }>> =
  {
    'sound.thunder-crack': { rate: 1.25, gain: 0.7 },
    'sound.cannon-boom': { rate: 0.62, gain: 0.9 },
    'sound.thunderclap-hawk': { rate: 0.8, gain: 0.9, hawk: true },
  }

const EXTRAS: Partial<Record<ItemId, Partial<ActorOpts>>> = {
  'extra.handlebar': { moustache: 0x3a_24_14, moustacheStyle: 'handlebar' },
  'extra.red-bandana': { bandana: 0x9a_1a_14 },
  'extra.tin-star': { star: true },
  'extra.black-bandana': { bandana: 0x15_12_0f },
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

/** Convert roster item IDs to the slot map used by the Outfitter. */
export function catalogLoadout(ids: readonly string[]): Loadout {
  const slots: Record<string, string> = {}
  for (const id of ids) {
    const item = itemById(id)
    if (item) {
      slots[item.slot] = item.id
    }
  }
  return normalizeLoadout(slots)
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
    hatDetail: hatDetailFor(l.hat),
    hatColor: dyeHex(dyes[l.hat]) ?? hat?.color ?? 0x5a_42_2e,
    tint: outfit.tint ?? {},
    seed: `loadout/${l.hat}/${l.outfit}/${l.extra ?? ''}`,
    holster: holster && holsterDye !== null ? { ...holster, color: holsterDye } : holster,
    ...extra,
  }
  if (outfit.coat !== undefined) {
    o.coat = outfit.coat
    o.coatCut = outfit.coatCut ?? 'duster'
  }
  if (outfit.poncho !== undefined) {
    o.poncho = outfit.poncho
  }
  if (outfit.bandoliers) {
    o.bandoliers = true
  }
  if (outfit.vest !== undefined) {
    o.vest = outfit.vest
  }
  // the outfit's own neckerchief, unless the extra slot puts one on
  if (outfit.bandana !== undefined && o.bandana === undefined) {
    o.bandana = outfit.bandana
  }
  return o
}

/**
 * The Peacemaker in a finish, at the size `gun` was made at (its own geometry in the guns' one
 * material: a finish never costs a program), with its hammer and cylinder on their pivots when
 * `gun` has them.
 */
function finishedRevolver(gun: PropDef, look: GunLook, still = false): Object3D {
  const made = gun.userData?.revolver as { size: number; articulated?: boolean } | undefined
  const g = revolverObject({
    size: made?.size ?? gun.size.x,
    look: look.finish,
    articulated: !still && made?.articulated === true,
  })
  return g
}

/** The equipped gun's finish, shared by world, crowd and first-person rendering. */
export function gunFinish(id: ItemId | undefined): RevolverLook {
  return (id ? GUNS[id] : undefined)?.finish ?? PEACEMAKER
}
export const gunIsPair = (id: ItemId | undefined): boolean => Boolean(id && GUNS[id]?.twin)
export function equippedGun(gun: PropDef, id: ItemId | undefined): Object3D {
  return finishedRevolver(gun, (id ? GUNS[id] : undefined) ?? { finish: PEACEMAKER })
}

/** A catalog gun preview, including both guns for a pair; null for non-gun items. */
export function finishedGun(gun: PropDef, id: ItemId): Object3D | null {
  const look = GUNS[id]
  if (!look) {
    return null
  }
  const first = finishedRevolver(gun, look, true)
  if (!look.twin) {
    return first
  }
  const pair = new Group()
  first.position.set(0.035, 0.065, 0.025)
  first.rotation.z = 0.12
  const second = finishedRevolver(gun, look, true)
  second.position.set(-0.035, -0.065, -0.025)
  second.rotation.z = -0.12
  pair.add(first, second)
  return pair
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
  markFlat(mat)
  const geo = spurGeometry(look.points, look.points === 10)
  for (const foot of feet) {
    const rowel = new Mesh(geo, mat)
    const p = foot.getWorldPosition(new Vector3())
    rowel.position
      .copy(p)
      .addScaledVector(back, 0.11)
      .setY(Math.max(0.05, p.y - 0.02))
    rowel.quaternion
      .copy(rootQ)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2))
    rowel.userData.actorMaterial = true
    rowel.userData.corpseGear = 'spurs'
    rowel.castShadow = true
    rowel.receiveShadow = true
    a.root.add(rowel)
    foot.attach(rowel)
  }
}

/**
 * A whole gunslinger dressed in `loadout`, on the player's rig. Used for you (single player and
 * Bounty Hunt) and for your opponent, built from their server-validated loadout and dyes, with
 * their own face and build (`who`, scene/identity.ts) under the kit.
 */
export function fitCatalogSpurs(actor: Actor, id: ItemId | undefined): void {
  const look = id ? SPURS[id] : undefined
  if (look) {
    fitSpurs(actor, look)
  }
}

export function dressedActor(
  model: GLTF,
  gun: PropDef | null,
  raw: unknown,
  o: { dyes?: Dyes | undefined; who?: Identity } = {},
): Actor {
  const dyes = o.dyes ?? {}
  const who = o.who ?? {}
  const l: Loadout = normalizeLoadout(raw)
  const gunLook = GUNS[l.gun] ?? GUNS['gun.rusty-six']
  // finished before he is dressed, so the holster is fitted to the gun he carries (a Buntline's
  // longer barrel gets a longer holster, and its muzzle is measured where it is)
  const proto = gun && gunLook ? finishedRevolver(gun, gunLook) : null
  const kit = loadoutOpts(l, dyes)
  const a = new Actor(model, {
    // who he is under the kit; the kit's own colours and extras win
    ...who,
    ...kit,
    tint: { ...who.tint, ...kit.tint },
    gun: proto,
    offGun: gunLook?.twin ?? false,
  })
  const spurs = SPURS[l.spurs]
  if (spurs) {
    fitSpurs(a, spurs)
  }
  return a
}
