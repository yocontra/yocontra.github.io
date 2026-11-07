// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * The pure parts of building an actor, kept apart from the `Actor` class that owns its state:
 * his colours, the garments he wears, where a slot sits on a bone, how long his stride is, and
 * where his hat seats on his skull.
 */
import {
  type AnimationClip,
  type AnimationMixer,
  type Bone,
  Group,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three'
import type { BeardKey, CoatCut, MoustacheKey } from '../data/outlaws.ts'
import type { Piece } from './bake.ts'
import { coat, type GunSides } from './coat.ts'
import { beard, eyepatch, scar, vest } from './face.ts'
import type { HatDetail } from './hat-detail.ts'
import { type HatFit, makeHat } from './hats.ts'
import { bandana, bandoliers, type Fit, mask, star } from './outfit.ts'
import { HAIR_LUM } from './person.ts'
import { poncho } from './poncho.ts'
import { SLOT, type Slot, slotOf } from './roles.ts'
import type { Glow } from './shade.ts'
import { type Floor, vary } from './style.ts'

/** What the dressing and tinting read from an actor's options. */
export interface DressOpts {
  tint?: Readonly<Record<string, number>>
  /** Explicit palette channels used by the VAT authoring pass, independent of tint brightness. */
  paletteSlots?: Readonly<Partial<Record<Slot, number>>> | undefined
  bandana?: number | undefined
  coat?: number | undefined
  coatCut?: CoatCut | undefined
  poncho?: number | undefined
  vest?: number | undefined
  moustache?: number | undefined
  moustacheStyle?: MoustacheKey | undefined
  beard?: number | undefined
  beardStyle?: BeardKey | undefined
  sideburns?: number | undefined
  eyepatch?: boolean | undefined
  scar?: boolean | undefined
  bandoliers?: boolean | undefined
  star?: boolean | undefined
  mask?: number | undefined
  seed?: string
  /** His revolver(s): the coat is cut back behind each holster. */
  gun?: object | null | undefined
  offGun?: boolean | undefined
}

const tmpV = new Vector3()
const tmpQ = new Quaternion()

/** Hair-like materials: their atlas texels are a mid grey, so an explicit colour is normalised. */
const HAIRY = new Set(['Hair', 'Brows', 'Beard'])

/**
 * The tint of one of the base's materials: the outlaw's own, else the base's default (the
 * build gives the ranger's green a western colour, hair a brown); brows follow his hair and a
 * sculpted beard takes the beard colour.
 */
function tintFor(
  src: Material,
  tint: Readonly<Record<string, number>>,
  o: DressOpts,
): number | undefined {
  const own = tint[src.name]
  if (own !== undefined) {
    return own
  }
  // the sculpted beard is also his moustache and side whiskers (scene/whiskers.ts)
  const whisker = slotOf(src) === SLOT.Beard ? (o.beard ?? o.moustache ?? o.sideburns) : undefined
  if (whisker !== undefined) {
    return whisker
  }
  if ((slotOf(src) === SLOT.Brows || slotOf(src) === SLOT.Beard) && tint.Hair !== undefined) {
    return tint.Hair
  }
  return src.userData.tint as number | undefined
}

/** His own colours: each material tinted, then a seeded nudge so no two read identical. */
export function tintModel(model: Object3D, o: DressOpts): void {
  const tint = o.tint ?? {}
  const seed = o.seed ?? 'player'
  const cache = new Map<Material, Material>()
  const swap = (src: Material): Material => {
    const cached = cache.get(src)
    if (cached) {
      return cached
    }
    const c = src.clone() as MeshStandardMaterial
    const hex = tintFor(src, tint, o)
    const slot = slotOf(src)
    const palette = slot ? o.paletteSlots?.[slot] : undefined
    if (palette !== undefined) {
      c.userData.paletteSlot = palette
    }
    c.color.setHex(hex ?? 0xff_ff_ff)
    // a tinted garment is recoloured (its main fabric), untinted keeps its texture
    c.userData.recolor = hex !== undefined && ((src.userData.lum as number | undefined) ?? 0) > 0
    vary(c, seed)
    if (hex === undefined) {
      // untinted: the texture as authored (vary still sets roughness and rim)
      c.color.setHex(0xff_ff_ff)
    } else if (HAIRY.has(src.name) && hex !== src.userData.tint) {
      // his own hair colour reads as itself over the grey hair texels (the base default doesn't)
      c.color.multiplyScalar(1 / HAIR_LUM)
    }
    cache.set(src, c)
    return c
  }
  model.traverse((obj) => {
    const m = obj as Mesh
    if (m.isMesh) {
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
    }
  })
}

/** Everything he wears, fitted and skinned (see outfit.ts). */
export function dressPieces(f: Fit, o: DressOpts, root: Object3D, realBeard: boolean): Piece[] {
  const out: Piece[] = []
  const holstered: GunSides = o.offGun ? [1, -1] : [1]
  const sides: GunSides = o.gun ? holstered : []
  if (o.coat !== undefined) {
    out.push(...coat(f, o.coat, o.coatCut ?? 'duster', sides))
  }
  if (o.poncho !== undefined) {
    out.push(...poncho(f, o.poncho, sides))
  }
  if (o.vest !== undefined && o.poncho === undefined) {
    out.push(...vest(f, o.vest))
  }
  if (o.mask !== undefined) {
    out.push(...mask(f, o.mask))
  } else if (o.bandana !== undefined) {
    out.push(...bandana(f, o.bandana))
  }
  if (o.bandoliers) {
    out.push(...bandoliers(f, root))
  }
  if (o.star) {
    out.push(...star(f, root))
  }
  // a fitted shell only for a full beard, or a base without a sculpted one to cut from
  if (o.beard !== undefined && (o.beardStyle === 'full' || !realBeard)) {
    out.push(...beard(f, o.beard, o.beardStyle))
  }
  if (o.eyepatch) {
    out.push(...eyepatch(f, root))
  }
  if (o.scar && o.mask === undefined) {
    out.push(...scar(f, root))
  }
  return out
}

/** A bone-local slot that holds world-space-authored children (unit scale, root orientation). */
export function slotOn(bone: Bone, worldPos: Vector3, worldQuat: Quaternion): Group {
  const slot = new Group()
  bone.add(slot)
  bone.updateMatrixWorld(true)
  const inv = bone.matrixWorld.clone().invert()
  slot.position.copy(worldPos.clone().applyMatrix4(inv))
  bone.getWorldQuaternion(tmpQ)
  slot.quaternion.copy(tmpQ.clone().invert().multiply(worldQuat))
  const ws = bone.getWorldScale(new Vector3())
  slot.scale.setScalar(1 / ws.x)
  return slot
}

export interface Stride {
  /** Distance per pace at full stride, or null when the clip doesn't give a sane one. */
  paceLength: number | null
  /** Walk clip time of each heel strike. */
  heelStrikes: number[]
}

/** Sample the walk clip to find stride length and heel-strike times (no foot sliding). */
export function measureStride(
  rig: { mixer: AnimationMixer; root: Object3D; feet: readonly [Bone, Bone] },
  clip: AnimationClip,
): Stride {
  const { mixer, root } = rig
  const [footL, footR] = rig.feet
  const action = mixer.clipAction(clip)
  action.reset().play()
  action.weight = 1
  const n = 48
  const zl: number[] = []
  const zr: number[] = []
  const inv = root.matrixWorld.clone().invert()
  for (let i = 0; i < n; i++) {
    mixer.setTime((i / n) * clip.duration)
    root.updateMatrixWorld(true)
    inv.copy(root.matrixWorld).invert()
    zl.push(footL.getWorldPosition(tmpV).applyMatrix4(inv).z)
    zr.push(footR.getWorldPosition(tmpV).applyMatrix4(inv).z)
  }
  action.stop()
  const range = (a: number[]) => Math.max(...a) - Math.min(...a)
  const stride = (range(zl) + range(zr)) / 2
  const argmax = (a: number[]) => a.indexOf(Math.max(...a))
  return {
    paceLength: stride > 0.2 && stride < 1.5 ? stride : null,
    heelStrikes: [(argmax(zl) / n) * clip.duration, (argmax(zr) / n) * clip.duration].sort(
      (a, b) => a - b,
    ),
  }
}

/** The actor's hat finish and the material state it follows. */
export function hatStyle(
  o: { hatColor?: number; hatDetail?: HatDetail | undefined },
  floor: Floor,
  glow: Glow,
) {
  return { color: o.hatColor ?? 0x3a_2a_1a, floor, glow, detail: o.hatDetail }
}

/**
 * Seat a hat on his head bone where `fitHat` measured it (scene/hats.ts): the band on his
 * skull, the crown hugging it, turned with his face.
 */
export function seatHat(
  f: HatFit,
  hat: { color: number; floor: Floor; glow: Glow; detail?: HatDetail | undefined },
  on: { head: Bone; root: Object3D },
): Group {
  const g = makeHat(f.key, hat.color, hat)
  g.children[0]?.scale.setScalar(f.s)
  const q = on.root
    .getWorldQuaternion(new Quaternion())
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), f.yaw))
  const slot = slotOn(on.head, new Vector3(f.cx, f.y, f.cz), q)
  slot.add(g)
  g.rotation.x = -f.tilt
  return g
}

/** Every actor owns its skeleton's bone texture; release it with the animation rig. */
export function retireRig(
  mixer: AnimationMixer,
  root: Object3D,
  meshes: readonly SkinnedMesh[],
): void {
  mixer.stopAllAction()
  for (const mesh of meshes) {
    mesh.skeleton.dispose()
  }
  root.removeFromParent()
}

/** Move a carried prop to its fitted slot; leave an already-seated draw pose alone. */
export function seatProp(prop: Object3D | null, slot: Object3D | null): void {
  if (prop && slot && prop.parent !== slot) {
    slot.add(prop)
    prop.position.set(0, 0, 0)
    prop.rotation.set(0, 0, 0)
  }
}
