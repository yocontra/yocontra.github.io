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
  type Material,
  type Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey, Build, FaceShape, HairKey, SkinKey, Stance } from '../data/outlaws.ts'
import type { Piece } from './bake.ts'
import { type Body, boneKey } from './fit.ts'

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

const isSkinned = (o: Object3D): o is SkinnedMesh => (o as SkinnedMesh).isSkinnedMesh
const matName = (m: SkinnedMesh): string =>
  ((Array.isArray(m.material) ? m.material[0] : m.material) as Material | undefined)?.name ?? ''

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

/** Landmarks of the bind mesh (skin space: Y up, facing +Z). */
interface Land {
  head: Vector3
  eye: number
  chin: number
  spine: Vector3
  chest: Vector3
  hips: number
}

/** Bind-space bone positions by name, from a skeleton's inverse bind matrices. */
function bindBones(sm: SkinnedMesh): Map<string, Vector3> {
  const out = new Map<string, Vector3>()
  sm.skeleton.bones.forEach((b, i) => {
    const inv = sm.skeleton.boneInverses[i]
    if (inv) {
      out.set(boneKey(b.name), new Vector3().setFromMatrixPosition(inv.clone().invert()))
    }
  })
  return out
}

/** Weight of each named bone on vertex `k` of `sm`. */
function weightsOf(sm: SkinnedMesh, k: number, names: readonly string[]): Map<string, number> {
  const si = sm.geometry.getAttribute('skinIndex')
  const sw = sm.geometry.getAttribute('skinWeight')
  const out = new Map<string, number>()
  for (let c = 0; c < 4; c++) {
    const w = sw.getComponent(k, c)
    const n = boneKey(sm.skeleton.bones[si.getComponent(k, c)]?.name ?? '')
    if (w > 0 && names.includes(n)) {
      out.set(n, (out.get(n) ?? 0) + w)
    }
  }
  return out
}

function landmarks(meshes: readonly SkinnedMesh[]): Land | null {
  const first = meshes[0]
  if (!first) {
    return null
  }
  const bb = bindBones(first)
  const head = bb.get('Head')
  const chest = bb.get('Chest')
  const spine = bb.get('Abdomen') ?? bb.get('Torso')
  const hips = bb.get('Hips')
  if (!(head && chest && spine && hips)) {
    return null
  }
  const v = new Vector3()
  let eyeSum = 0
  let eyeN = 0
  let chin = Number.POSITIVE_INFINITY
  for (const sm of meshes) {
    const name = matName(sm)
    const pos = sm.geometry.getAttribute('position')
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(sm.bindMatrix)
      if (name === 'Eye') {
        eyeSum += v.y
        eyeN++
      } else if (
        name === 'Skin' &&
        v.z > head.z &&
        (weightsOf(sm, k, ['Head']).get('Head') ?? 0) > 0.9
      ) {
        chin = Math.min(chin, v.y)
      }
    }
  }
  if (eyeN === 0 || !Number.isFinite(chin)) {
    return null
  }
  return { head, eye: eyeSum / eyeN, chin, spine, chest, hips: hips.y }
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

const HANDS = /^(Wrist|Fist|Index|Middle|Pinky|Ring|Thumb)/u

/**
 * Skin tone, stubble and gloves, painted on the baked skin's per-vertex tint (the skin is drawn
 * texel × tint). `head` is his measured head (root space).
 */
export function paintSkin(
  pieces: readonly Piece[],
  body: Body,
  head: { cx: number; cz: number; chin: number; eye: number },
  o: SkinLook,
): void {
  const tone = SKIN_TONES[o.skin ?? 'tan'] ?? SKIN_TONES.tan
  const glove = o.gloves === undefined ? null : linearOver(o.gloves, SKIN_TEXEL)
  const stubble = Math.min(1, Math.max(0, o.stubble ?? 0))
  if (tone === SKIN_TONES.tan && !glove && stubble === 0) {
    return
  }
  const span = head.eye - head.chin
  const lip = head.chin + 0.56 * span
  for (const p of pieces) {
    const skin = p.skin
    if (p.name !== 'Skin' || !skin) {
      continue
    }
    const col = p.geo.getAttribute('color')
    const pos = p.geo.getAttribute('position')
    for (let k = 0; k < col.count; k++) {
      let best = 0
      let bone = ''
      for (let c = 0; c < 4; c++) {
        const w = skin.weight[k * 4 + c] ?? 0
        if (w > best) {
          best = w
          bone = boneKey(body.bones[skin.index[k * 4 + c] ?? 0]?.name ?? '')
        }
      }
      let r = col.getX(k) * tone[0]
      let g = col.getY(k) * tone[1]
      let b = col.getZ(k) * tone[2]
      if (glove && HANDS.test(bone)) {
        ;[r, g, b] = glove
      } else if (stubble > 0 && bone === 'Head') {
        const y = pos.getY(k)
        const front = pos.getZ(k) - head.cz > -0.035
        const a = front
          ? stubble *
            smooth(lip + 0.006, lip - 0.014, y) *
            smooth(head.chin - 0.06, head.chin - 0.02, y)
          : 0
        r *= 1 - 0.74 * a
        g *= 1 - 0.7 * a
        b *= 1 - 0.6 * a
      }
      col.setXYZ(k, r, g, b)
    }
    col.needsUpdate = true
  }
}

/** The tint that makes `over` (a texel of this mean colour) read as `hex`. */
function linearOver(
  hex: number,
  over: readonly [number, number, number],
): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.040_45 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const c = [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff].map(lin)
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

  get empty(): boolean {
    return this.parts.length === 0
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
