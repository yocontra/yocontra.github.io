// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isSkinnedMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * Who he is under the clothes: the parts of a man that make him himself rather than his base.
 *
 * All of it is decided before he is measured and baked (scene/actor.ts), so the fitted garments,
 * the hat and the holsters are measured on the man he became, and he stays one skinned draw:
 * - his hair cut, borrowed from the base that wears it (every base shares the skeleton and head);
 * - the lower face and the torso reshaped on the bind mesh (jaw, face length, chest, belly),
 *   weighted by the bones under each vertex so it stays smooth into the neck and hips;
 * - his head size, neck length and shoulder width as bone scales and offsets (the clips animate
 *   only rotations, and translation on the hips alone, so they hold through every clip);
 * - skin tone, stubble and gloves as per-vertex tint on the baked skin;
 * - a standing habit (head tilt, chin, lean, weight on a hip), layered on every clip.
 */
import {
  type Bone,
  type BufferGeometry,
  Euler,
  type Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type {
  BeardKey,
  BodyKey,
  Build,
  FaceShape,
  HairKey,
  MoustacheKey,
  SkinKey,
  Stance,
} from '../data/outlaws.ts'
import type { Piece } from './bake.ts'
import { isSkinned, type Land, landmarks, matName, weightsOf } from './bind.ts'
import { type Body, boneKey } from './fit.ts'
import { prune } from './outfit.ts'
import { trimWhiskers, type WhiskerLook, wearsWhiskers } from './whiskers.ts'

/**
 * Mean linear luminance of the atlas's hair, brows and beard (a mid grey). A hair colour is the
 * colour it should read as, so the tint is divided by it (the shader multiplies the texel).
 */
export const HAIR_LUM = 0.27
/** Mean linear colour of the atlas's skin, so a glove can be tinted to the colour it reads as. */
const SKIN_TEXEL = [0.338, 0.145, 0.071] as const

/** Skin tones as multipliers on the atlas skin (`tan` is the skin as painted). */
export const SKIN_TONES: Readonly<Record<SkinKey, readonly [number, number, number]>> = {
  pale: [1.62, 1.86, 1.96],
  fair: [1.34, 1.42, 1.46],
  ruddy: [1.34, 1.08, 1.0],
  tan: [1, 1, 1],
  olive: [0.8, 0.86, 0.7],
  brown: [0.54, 0.5, 0.48],
  dark: [0.32, 0.29, 0.3],
}

/** The cut each base is built with. */
const NATIVE_HAIR: Readonly<Record<BodyKey, HairKey>> = {
  casual: 'short',
  suit: 'short',
  rugged: 'crop',
  worker: 'crop',
  punk: 'crop',
  king: 'long',
  woman: 'long',
}

/** The base whose hair mesh is borrowed for a cut. */
const HAIR_DONOR: Readonly<Record<Exclude<HairKey, 'bald'>, BodyKey>> = {
  short: 'casual',
  crop: 'worker',
  long: 'king',
}

/**
 * The base to borrow his hair from, or null for his own (or none). The woman keeps hers: her head
 * is her own mesh, not the men's.
 */
export function hairDonor(base: BodyKey, hair: HairKey | undefined): BodyKey | null {
  if (!hair || hair === 'bald' || base === 'woman' || NATIVE_HAIR[base] === hair) {
    return null
  }
  return HAIR_DONOR[hair] ?? null
}

/** Who he is under the clothes: the actor options this module (and scene/face.ts) reads. */
export interface PersonOpts {
  vest?: number | undefined
  moustacheStyle?: MoustacheKey | undefined
  beardStyle?: BeardKey | undefined
  sideburns?: number | undefined
  stubble?: number | undefined
  eyepatch?: boolean | undefined
  scar?: boolean | undefined
  gloves?: number | undefined
  skin?: SkinKey | undefined
  hair?: HairKey | undefined
  /** The base whose hair mesh his cut borrows (null: his own). */
  hairFrom?: GLTF | null
  build?: Build | undefined
  face?: FaceShape | undefined
  stance?: Stance | undefined
}

/**
 * Give him another cut: drop his own hair, and (unless he goes bald) bind the donor base's hair
 * mesh to his bones by name, with the donor's bind pose (the skeletons are the same rig).
 */
export function swapHair(
  model: Object3D,
  bones: ReadonlyMap<string, Bone>,
  hair: HairKey | undefined,
  donor: GLTF | null,
): void {
  if (hair !== 'bald' && !donor) {
    return
  }
  const own: SkinnedMesh[] = []
  model.traverse((o) => {
    if (isSkinned(o) && matName(o) === 'Hair') {
      own.push(o)
    }
  })
  const parent = own[0]?.parent ?? null
  for (const o of own) {
    o.removeFromParent()
  }
  if (!(donor && parent)) {
    return
  }
  donor.scene.traverse((o) => {
    if (!isSkinned(o) || matName(o) !== 'Hair') {
      return
    }
    const mapped = o.skeleton.bones.map((b) => bones.get(boneKey(b.name)) ?? null)
    if (mapped.some((b) => b === null)) {
      return
    }
    const m = new SkinnedMesh(o.geometry, o.material)
    m.name = o.name
    m.position.copy(o.position)
    m.quaternion.copy(o.quaternion)
    m.scale.copy(o.scale)
    parent.add(m)
    m.bind(
      new Skeleton(
        mapped as Bone[],
        o.skeleton.boneInverses.map((b) => b.clone()),
      ),
      o.bindMatrix.clone(),
    )
  })
}

/**
 * Make the cloned base into him, before he is normalised, measured or dressed: drop the parts he
 * doesn't wear (the sculpted beard unless it is his), collect his bones into `bones`, give him
 * his cut, reshape his face and torso, and set his proportions on the bones. His overall height
 * (`scale`) is then normalised over all of it. Returns whether he keeps the sculpted beard.
 */
export function becomeHimself(
  model: Object3D,
  bones: Map<string, Bone>,
  o: PersonOpts & WhiskerLook,
): boolean {
  prune(model, { beard: wearsWhiskers(o) })
  trimWhiskers(model, o)
  let sculpted = false
  model.traverse((obj) => {
    const b = obj as Bone
    if (b.isBone) {
      bones.set(boneKey(b.name), b)
    }
    if (isSkinned(obj) && matName(obj) === 'Beard') {
      sculpted = true
    }
  })
  swapHair(model, bones, o.hair, o.hairFrom ?? null)
  reshape(model, o.build, o.face)
  applyBuild(bones, o.build)
  return sculpted
}

/** Bone proportions (head size, neck length, shoulder width). Call before he is measured. */
export function applyBuild(bones: ReadonlyMap<string, Bone>, b: Build | undefined): void {
  if (!b) {
    return
  }
  const head = bones.get('Head')
  if (head && b.head !== undefined) {
    head.scale.multiplyScalar(b.head)
  }
  if (head && b.neck !== undefined) {
    head.position.multiplyScalar(b.neck)
  }
  if (b.shoulders !== undefined) {
    for (const n of ['UpperArmL', 'UpperArmR']) {
      bones.get(n)?.position.multiplyScalar(b.shoulders)
    }
  }
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const TORSO = ['Head', 'Chest', 'Torso', 'Abdomen', 'Hips', 'ShoulderL', 'ShoulderR'] as const

/** The offset of one bind-space vertex `v` (weights `w`) for this face and build. */
function offset(
  v: Vector3,
  w: ReadonlyMap<string, number>,
  L: Land,
  s: { face: FaceShape; chest: number; belly: number },
): Vector3 {
  const d = new Vector3()
  const wh = w.get('Head') ?? 0
  const span = Math.max(0.01, L.eye - L.chin)
  if (wh > 0 && v.y < L.eye) {
    const below = Math.min(1.2, (L.eye - v.y) / span)
    d.x += (v.x - L.head.x) * (s.face.jaw ?? 0) * below ** 1.5 * wh
    d.y -= (s.face.long ?? 0) * Math.min(L.eye - v.y, span) * wh
  }
  const wc =
    (w.get('Chest') ?? 0) +
    0.5 * (w.get('Torso') ?? 0) +
    0.4 * ((w.get('ShoulderL') ?? 0) + (w.get('ShoulderR') ?? 0))
  if (wc > 0 && s.chest !== 1) {
    const k = (s.chest - 1) * wc
    d.x += (v.x - L.chest.x) * k
    d.z += (v.z - L.chest.z) * k
  }
  const wb =
    (w.get('Abdomen') ?? 0) +
    0.6 * (w.get('Torso') ?? 0) +
    0.45 * (w.get('Hips') ?? 0) * smooth(L.hips - 0.06, L.hips + 0.04, v.y)
  if (wb > 0 && s.belly !== 1) {
    const k = (s.belly - 1) * wb
    const front = v.z > L.spine.z
    d.x += (v.x - L.spine.x) * k * 0.7
    d.z += (v.z - L.spine.z) * k * (front ? 1.9 : 0.35)
  }
  return d
}

/**
 * Reshape his bind mesh: jaw and face length, chest and belly girth (every garment with the body,
 * by the same weights). His geometry is cloned first: the base's is shared by every clone.
 */
export function reshape(
  model: Object3D,
  build: Build | undefined,
  face: FaceShape | undefined,
): void {
  const s = { face: face ?? {}, chest: build?.chest ?? 1, belly: build?.belly ?? 1 }
  if (!(s.face.jaw || s.face.long) && s.chest === 1 && s.belly === 1) {
    return
  }
  const meshes: SkinnedMesh[] = []
  model.traverse((o) => {
    if (isSkinned(o)) {
      meshes.push(o)
    }
  })
  const L = landmarks(meshes)
  if (!L) {
    return
  }
  const v = new Vector3()
  for (const sm of meshes) {
    const geo: BufferGeometry = sm.geometry.clone()
    sm.geometry = geo
    const pos = geo.getAttribute('position')
    const inv = sm.bindMatrixInverse
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(sm.bindMatrix)
      v.add(offset(v, weightsOf(sm, k, TORSO), L, s)).applyMatrix4(inv)
      pos.setXYZ(k, v.x, v.y, v.z)
    }
    pos.needsUpdate = true
    geo.computeBoundingSphere()
  }
}

/** What the skin pass reads off his look. */
export interface SkinLook {
  skin?: SkinKey | undefined
  stubble?: number | undefined
  gloves?: number | undefined
}

const HANDS = /^(?:Wrist|Fist|Index|Middle|Pinky|Ring|Thumb)/u

/** The bone carrying most of vertex `k`'s weight (punctuation-free name). */
function dominant(skin: NonNullable<Piece['skin']>, body: Body, k: number): string {
  let best = 0
  let bone = ''
  for (let c = 0; c < 4; c++) {
    const w = skin.weight[k * 4 + c] ?? 0
    if (w > best) {
      best = w
      bone = boneKey(body.bones[skin.index[k * 4 + c] ?? 0]?.name ?? '')
    }
  }
  return bone
}

interface Head {
  cx: number
  cz: number
  chin: number
  eye: number
}

/** How unshaven the skin at (y, z) of his face is, 0..1: jaw and upper lip, front half. */
function stubbleAt(head: Head, stubble: number, y: number, z: number): number {
  if (z - head.cz <= -0.035) {
    return 0
  }
  const lip = head.chin + 0.56 * (head.eye - head.chin)
  return (
    stubble * smooth(lip + 0.006, lip - 0.014, y) * smooth(head.chin - 0.06, head.chin - 0.02, y)
  )
}

/**
 * Skin tone, stubble and gloves, painted on the baked skin's per-vertex tint (the skin is drawn
 * texel × tint). `head` is his measured head (root space).
 */
export function paintSkin(pieces: readonly Piece[], body: Body, head: Head, o: SkinLook): void {
  const tone = SKIN_TONES[o.skin ?? 'tan'] ?? SKIN_TONES.tan
  const glove = o.gloves === undefined ? null : linearOver(o.gloves, SKIN_TEXEL)
  const stubble = Math.min(1, Math.max(0, o.stubble ?? 0))
  if (tone === SKIN_TONES.tan && !glove && stubble === 0) {
    return
  }
  for (const p of pieces) {
    const skin = p.skin
    if (p.name !== 'Skin' || !skin) {
      continue
    }
    const col = p.geo.getAttribute('color')
    const pos = p.geo.getAttribute('position')
    for (let k = 0; k < col.count; k++) {
      const bone = dominant(skin, body, k)
      if (glove && HANDS.test(bone)) {
        col.setXYZ(k, glove[0], glove[1], glove[2])
        continue
      }
      const a = bone === 'Head' ? stubbleAt(head, stubble, pos.getY(k), pos.getZ(k)) : 0
      col.setXYZ(
        k,
        col.getX(k) * tone[0] * (1 - 0.74 * a),
        col.getY(k) * tone[1] * (1 - 0.7 * a),
        col.getZ(k) * tone[2] * (1 - 0.6 * a),
      )
    }
    col.needsUpdate = true
  }
}

/** sRGB byte → linear. */
const toLinear = (byte: number): number => {
  const v = byte / 255
  return v <= 0.040_45 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** The tint that makes `over` (a texel of this mean colour) read as `hex`. */
function linearOver(
  hex: number,
  over: readonly [number, number, number],
): [number, number, number] {
  const c = [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff].map(toLinear)
  return [0, 1, 2].map((i) => Math.min(8, (c[i] ?? 0) / (over[i] ?? 1))) as [number, number, number]
}

/**
 * His standing habit, layered on whatever clip poses him: after the mixer each frame (`apply`),
 * taken off again before the next (`undo`), so it never accumulates when no clip is running.
 */
export class StanceLayer {
  private readonly parts: { bone: Bone; q: Quaternion; inv: Quaternion }[] = []
  private on = false

  constructor(bones: ReadonlyMap<string, Bone>, s: Stance) {
    const add = (name: string, x: number, z: number): void => {
      const bone = bones.get(name)
      if (bone && (x !== 0 || z !== 0)) {
        const q = new Quaternion().setFromEuler(new Euler(x, 0, z))
        this.parts.push({ bone, q, inv: q.clone().invert() })
      }
    }
    const hip = s.hip ?? 0
    add('Head', -(s.chin ?? 0), s.tilt ?? 0)
    add('Torso', s.lean ?? 0, 0)
    add('Abdomen', 0, hip)
    add('Chest', 0, -0.55 * hip)
  }

  /** His layer, or null when he stands as the clip has him. */
  static of(bones: ReadonlyMap<string, Bone>, s: Stance | undefined): StanceLayer | null {
    const layer = s ? new StanceLayer(bones, s) : null
    return layer && layer.parts.length > 0 ? layer : null
  }

  apply(): void {
    if (this.on) {
      return
    }
    for (const p of this.parts) {
      p.bone.quaternion.multiply(p.q)
    }
    this.on = true
  }

  undo(): void {
    if (!this.on) {
      return
    }
    for (const p of this.parts) {
      p.bone.quaternion.multiply(p.inv)
    }
    this.on = false
  }
}
