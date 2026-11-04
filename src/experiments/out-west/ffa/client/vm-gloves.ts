// biome-ignore-all lint/style/noExcessiveLinesPerFile: one glove builder (its tubes, the rig it is measured on, the palm, the fingers) and the body it is fitted to
// biome-ignore-all lint/style/noMagicNumbers: a glover's proportions, fractions of the hand they are cut to
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: flat passes over rings, sides and vertices
/**
 * The first-person arms, dressed for the lens: the source bodies are built to read at street
 * distance, so up close the hands are a few dozen facets and bare. For the view model only:
 *
 * - each hand is rebuilt as a leather glove (`gloveGeometry`): a rounded palm lofted from the
 *   wrist to the knuckle line, and each finger and the thumb a smooth tube through its own joints,
 *   swelling at the knuckles and rounded at the tip. It is measured on his own skeleton and his own
 *   hand (each finger's thickness is the source mesh's around that bone), and skinned to the same
 *   bones: the fist round the grip, the finger mirror and the trigger finger all move it. The source
 *   hand's triangles are dropped under it;
 * - the gauntlet cuffs: the forearm's last stretch before the wrist is tinted saddle leather, off
 *   the skin path (no skin wrap or blush), a little glossier;
 * - smooth shading: the arms' normals rebuilt with a crease angle, so the low-poly sleeves read as
 *   rounded forms instead of facets (hard edges past the crease stay hard).
 */
import {
  type BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  MeshStandardMaterial,
  type Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const HAND = /^(?:Wrist|Index|Middle|Ring|Pinky|Thumb)\d?[LR]$/u
/** Saddle leather, multiplied over the atlas's skin (the cuffs). */
const LEATHER = [0.46, 0.3, 0.19] as const
/** Material params for the cuff (styMat: roughness factor, rim strength; no skin flag). */
const GLOVE_MAT = [0.75, 0.55] as const
const CREASE = (70 * Math.PI) / 180
/** The glove's leather: the cuffs' brown, as their tint lands on the skin's atlas. */
const GLOVE_COLOR = 0x3b_23_15
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'] as const
/** Around each tube, and around the palm. */
const SIDES = 12
/** A finger joint's blend (± of a bone's length) and how much fuller its rings are. */
const JOINT_W = 0.42
const JOINT_FILL = 0.14
const PALM_SIDES = 18

type Side = 'L' | 'R'

/** One vertex's skin: up to two bones and the weight on the second. */
interface Skin {
  a: number
  b: number
  t: number
}

/** A tube's ring: its centre, its frame (u up off the back of the hand, v across), its radii. */
interface Ring {
  c: Vector3
  u: Vector3
  v: Vector3
  ru: number
  rv: number
  skin: Skin
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * A closed tube through `rings` (round-capped at the far end with `tip` rings, flat-capped at the
 * near end), with each vertex skinned as its ring is.
 */
function tube(rings: readonly Ring[], sides: number, tip: number): BufferGeometry {
  const all: Ring[] = [...rings]
  const last = rings.at(-1)
  const prev = rings.at(-2)
  if (last && prev && tip > 0) {
    const fwd = last.c.clone().sub(prev.c).normalize()
    for (let i = 1; i <= tip; i++) {
      const a = (i / (tip + 1)) * (Math.PI / 2)
      all.push({
        ...last,
        c: last.c.clone().addScaledVector(fwd, Math.sin(a) * Math.min(last.ru, last.rv)),
        ru: last.ru * Math.cos(a),
        rv: last.rv * Math.cos(a),
      })
    }
  }
  const pos: number[] = []
  const si: number[] = []
  const sw: number[] = []
  const idx: number[] = []
  const push = (at: Vector3, s: Skin) => {
    pos.push(at.x, at.y, at.z)
    si.push(s.a, s.b, 0, 0)
    sw.push(1 - s.t, s.t, 0, 0)
  }
  const p = new Vector3()
  for (const r of all) {
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2
      p.copy(r.c)
        .addScaledVector(r.u, Math.cos(a) * r.ru)
        .addScaledVector(r.v, Math.sin(a) * r.rv)
      push(p, r.skin)
    }
  }
  for (let i = 0; i < all.length - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * sides + k
      const b = i * sides + ((k + 1) % sides)
      const c = a + sides
      const d = b + sides
      idx.push(a, c, b, b, c, d)
    }
  }
  // the tip's point, and the flat cap at the start
  const end = all.at(-1)
  const first = all[0]
  if (end && first && last && prev) {
    const fwd = last.c.clone().sub(prev.c).normalize()
    const tipAt = pos.length / 3
    push(end.c.clone().addScaledVector(fwd, tip > 0 ? Math.min(end.ru, end.rv) * 0.6 : 0), end.skin)
    const base = (all.length - 1) * sides
    for (let k = 0; k < sides; k++) {
      idx.push(base + k, tipAt, base + ((k + 1) % sides))
    }
    // a digit's root is buried in the palm (a cap there pokes out of a curled knuckle); the
    // palm's root, inside the cuff, is closed
    if (tip === 0) {
      const startAt = pos.length / 3
      push(first.c, first.skin)
      for (let k = 0; k < sides; k++) {
        idx.push(startAt, k, (k + 1) % sides)
      }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4))
  g.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** The hand's bones in the body's bind space, and its source vertices by dominant bone. */
class HandRig {
  private readonly names: string[]
  private readonly joints: (Vector3 | null)[]
  private readonly verts = new Map<number, Vector3[]>()

  constructor(geo: BufferGeometry, skeleton: Skeleton, bindInverse: Matrix4) {
    this.names = skeleton.bones.map((b) => b.name)
    const m = new Matrix4()
    this.joints = skeleton.boneInverses.map((bi) =>
      new Vector3().setFromMatrixPosition(m.copy(bi).invert().premultiply(bindInverse)),
    )
    const pos = geo.getAttribute('position')
    const si = geo.getAttribute('skinIndex')
    const sw = geo.getAttribute('skinWeight')
    if (!(si && sw)) {
      return
    }
    for (let v = 0; v < pos.count; v++) {
      let best = 0
      let bw = -1
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k)
        if (w > bw) {
          bw = w
          best = si.getComponent(v, k)
        }
      }
      const list = this.verts.get(best) ?? []
      list.push(new Vector3().fromBufferAttribute(pos, v))
      this.verts.set(best, list)
    }
  }

  index(name: string): number {
    return this.names.indexOf(name)
  }

  at(name: string): Vector3 | null {
    const i = this.index(name)
    return i < 0 ? null : (this.joints[i]?.clone() ?? null)
  }

  /** The source mesh's thickness round the bone `name` along a→b: the median distance to the axis. */
  radius(name: string, a: Vector3, b: Vector3, fallback: number): number {
    const list = this.verts.get(this.index(name)) ?? []
    const ab = b.clone().sub(a)
    const len2 = Math.max(1e-10, ab.lengthSq())
    const d: number[] = []
    const q = new Vector3()
    for (const p of list) {
      const t = Math.min(1, Math.max(0, q.copy(p).sub(a).dot(ab) / len2))
      d.push(q.copy(a).addScaledVector(ab, t).distanceTo(p))
    }
    if (d.length < 4) {
      return fallback
    }
    d.sort((x, y) => x - y)
    return d[Math.floor(d.length * 0.6)] ?? fallback
  }

  /** The source vertices of `name`, for the palm's measure. */
  of(name: string): readonly Vector3[] {
    return this.verts.get(this.index(name)) ?? []
  }
}

/** A frame square to `along`, its u as near `up` as it can be. */
function frame(along: Vector3, up: Vector3): { u: Vector3; v: Vector3 } {
  const u = up.clone().addScaledVector(along, -up.dot(along)).normalize()
  return { u, v: new Vector3().crossVectors(along, u).normalize() }
}

/**
 * A digit's joints (its three bones), and its tip: the rig's tip bone when the body kept it, else
 * the last joint carried on by `tip` of the last bone's length.
 */
function chain(rig: HandRig, bones: readonly string[], tip: number): Vector3[] | null {
  const js = bones.slice(0, 3).map((n) => rig.at(n))
  const [a, b, c] = js
  if (!(a && b && c)) {
    return null
  }
  const end = rig.at(bones[3] ?? '') ?? c.clone().add(c.clone().sub(b).multiplyScalar(tip))
  return [a, b, c, end]
}

/** A finger (or the thumb) as rings through its joints, skinned bone by bone. */
function digit(
  rig: HandRig,
  o: {
    bones: readonly string[]
    joints: readonly Vector3[]
    wrist: number
    up: Vector3
    radii: readonly number[]
    flat: number
  },
): BufferGeometry | null {
  const ids = o.bones.slice(0, 3).map((b) => rig.index(b))
  if (ids.some((i) => i < 0)) {
    return null
  }
  const J = o.joints
  const j0 = J[0] as Vector3
  const j1 = J[1] as Vector3
  // from a little inside the palm, through each joint, to the tip
  const path: { p: Vector3; u: number }[] = [{ p: j0.clone().lerp(j1, -0.15), u: -0.15 }]
  for (let s = 0; s < J.length - 1; s++) {
    const a = J[s] as Vector3
    const b = J[s + 1] as Vector3
    for (const f of [0, 0.2, 0.4, 0.6, 0.8]) {
      path.push({ p: a.clone().lerp(b, f), u: s + f })
    }
  }
  const tipJ = J.at(-1) as Vector3
  path.push({ p: tipJ.clone(), u: J.length - 1 })
  const segs = J.length - 1
  const bone = (s: number): number => ids[Math.max(0, Math.min(segs - 1, s))] ?? 0
  const rings: Ring[] = path.map(({ p, u }, i) => {
    const a = path[Math.max(0, i - 1)]?.p ?? p
    const b = path[Math.min(path.length - 1, i + 1)]?.p ?? p
    const along = b.clone().sub(a).normalize()
    const f = frame(along, o.up)
    const s = Math.max(0, Math.min(segs - 1, Math.floor(u)))
    const r0 = o.radii[s] ?? 0.008
    // the knuckles fill out: a curled joint's blended rings fold in on the palm side (linear
    // skinning loses volume at the bend), so a joint's rings are fuller to keep the finger round
    const knuckle =
      Math.max(0, 1 - Math.abs(u - Math.round(u)) / JOINT_W) *
      (Math.round(u) < segs && Math.round(u) >= 1 ? JOINT_FILL : 0)
    const taper = 1 - smooth(segs - 0.6, segs, u) * 0.12
    const r = r0 * (1 + knuckle) * taper
    // the skin: the wrist into the first bone round the base knuckle, each joint blended
    let skin: Skin
    if (u < 0.25) {
      skin = { a: o.wrist, b: bone(0), t: smooth(-0.15, 0.3, u) }
    } else {
      const j = Math.round(u)
      const near = Math.abs(u - j) < JOINT_W && j >= 1 && j < segs
      skin = near
        ? { a: bone(j - 1), b: bone(j), t: smooth(j - JOINT_W, j + JOINT_W, u) }
        : { a: bone(s), b: bone(s), t: 0 }
    }
    return { c: p, u: f.u, v: f.v, ru: r * o.flat, rv: r, skin }
  })
  return tube(rings, SIDES, 3)
}

/** How much of a palm ring rides the forearm: all of the cuff, half the wrist, none of the hand. */
function cuffWeight(f: number): number {
  if (f < -0.15) {
    return 1
  }
  return f < 0 ? 0.5 : 0
}

/** The palm: lofted from just inside the cuff to round over the knuckles. */
function palm(
  rig: HandRig,
  side: Side,
  h: {
    wrist: Vector3
    knuckles: Vector3
    across: Vector3
    up: Vector3
    wristBone: number
    foreBone: number
  },
  fingerR: number,
): BufferGeometry | null {
  const i1 = rig.at(`Index1${side}`)
  const p1 = rig.at(`Pinky1${side}`)
  if (!(i1 && p1)) {
    return null
  }
  const along = h.knuckles.clone().sub(h.wrist)
  const len = along.length()
  along.normalize()
  const span = Math.abs(i1.clone().sub(p1).dot(h.across))
  const wK = span + fingerR * 1.9
  // its thickness: the source palm's, across the back of the hand
  let lo = 0
  let hi = 0
  for (const p of rig.of(`Wrist${side}`)) {
    const d = p.clone().sub(h.wrist).dot(h.up)
    lo = Math.min(lo, d)
    hi = Math.max(hi, d)
  }
  const tK = Math.min(wK * 0.36, Math.max(wK * 0.26, (hi - lo) * 0.7 || wK * 0.3))
  const fingers = FINGERS.map((f) => ({
    id: rig.index(`${f}1${side}`),
    x: (rig.at(`${f}1${side}`) ?? h.knuckles).clone().sub(h.knuckles).dot(h.across),
  }))
  // the forearm just behind the wrist (its source vertices' reach off the hand's axis), for the
  // gauntlet's cuff
  const reach: number[] = []
  for (const p of rig.of(`LowerArm${side}`)) {
    const d = p.clone().sub(h.wrist)
    const back = -d.dot(along)
    if (back > 0 && back < len * 0.45) {
      reach.push(d.addScaledVector(along, back).length())
    }
  }
  reach.sort((a, b) => a - b)
  const rF = Math.max(wK * 0.32, reach[Math.floor(reach.length * 0.9)] ?? wK * 0.4)
  // (fraction along, width, thickness): the gauntlet's flared cuff over the sleeve's end, the
  // wrist, the palm, rounding over the knuckles
  const sections: [number, number, number][] = [
    [-0.6, (rF * 2.04) / wK, (rF * 2.04) / tK],
    [-0.54, (rF * 2.16) / wK, (rF * 2.16) / tK],
    [-0.4, (rF * 2.12) / wK, (rF * 2.1) / tK],
    [-0.2, (rF * 2.02) / wK, (rF * 1.9) / tK],
    [-0.06, 0.62, 0.86],
    [0.06, 0.72, 0.94],
    [0.35, 0.9, 1.04],
    [0.68, 0.98, 1.0],
    [0.92, 1.0, 0.94],
    [1.03, 0.94, 0.78],
    [1.08, 0.78, 0.5],
  ]
  const rings: Ring[] = sections.map(([f, w, t]) => ({
    c: h.wrist.clone().addScaledVector(along, f * len),
    u: h.up.clone(),
    v: h.across.clone(),
    ru: (tK * t) / 2,
    rv: (wK * w) / 2,
    // the cuff rides the forearm; the wrist turns half with it, so the seam bends smoothly
    skin: { a: h.wristBone, b: h.foreBone, t: cuffWeight(f) },
  }))
  const g = tube(rings, PALM_SIDES, 0)
  // a squarer section than an ellipse (a hand is flat across the back), and the knuckle end
  // skinned toward the nearest finger so it bends with the fist
  const pos = g.getAttribute('position') as BufferAttribute
  const si = g.getAttribute('skinIndex') as BufferAttribute
  const sw = g.getAttribute('skinWeight') as BufferAttribute
  const q = new Vector3()
  for (let v = 0; v < pos.count; v++) {
    q.fromBufferAttribute(pos, v).sub(h.wrist)
    const f = q.dot(along) / len
    const x = q.dot(h.across)
    const y = q.dot(h.up)
    const ring = rings[Math.min(rings.length - 1, Math.floor(v / PALM_SIDES))]
    if (ring && v < rings.length * PALM_SIDES && f > -0.1) {
      // superellipse toward a rounded box
      const nx = x / ring.rv
      const ny = y / ring.ru
      const k =
        Math.hypot(nx, ny) > 0 ? 1 / (Math.abs(nx) ** 2.5 + Math.abs(ny) ** 2.5) ** (1 / 2.5) : 1
      const sq = Math.min(1.1, Math.hypot(nx, ny) * k)
      q.multiplyScalar(1)
      const out = h.wrist
        .clone()
        .addScaledVector(along, f * len)
        .addScaledVector(h.across, x * sq)
        .addScaledVector(h.up, y * sq)
      pos.setXYZ(v, out.x, out.y, out.z)
    }
    const t = smooth(0.78, 1.04, f) * 0.7
    if (t > 0) {
      let best = fingers[0]
      for (const fi of fingers) {
        if (best && Math.abs(fi.x - x) < Math.abs(best.x - x)) {
          best = fi
        }
      }
      if (best && best.id >= 0) {
        si.setXY(v, h.wristBone, best.id)
        sw.setXY(v, 1 - t, t)
      }
    }
  }
  g.computeVertexNormals()
  return g
}

/** One glove for a hand, in the body's bind space; null when the rig has no such hand. */
function gloveGeometry(rig: HandRig, side: Side): BufferGeometry | null {
  const wristBone = rig.index(`Wrist${side}`)
  const wrist = rig.at(`Wrist${side}`)
  const ks = FINGERS.map((f) => rig.at(`${f}1${side}`))
  const i1 = rig.at(`Index1${side}`)
  const p1 = rig.at(`Pinky1${side}`)
  const t3 = rig.at(`Thumb3${side}`)
  if (wristBone < 0 || !(wrist && i1 && p1 && t3) || ks.some((k) => k === null)) {
    return null
  }
  const knuckles = (ks as Vector3[])
    .reduce((acc, k) => acc.add(k), new Vector3())
    .multiplyScalar(1 / ks.length)
  const along = knuckles.clone().sub(wrist).normalize()
  const across = i1.clone().sub(p1)
  across.addScaledVector(along, -across.dot(along)).normalize()
  // the back of the hand: away from the thumb, which works on the palm side
  const up = new Vector3().crossVectors(along, across).normalize()
  if (t3.clone().sub(wrist).dot(up) > 0) {
    up.negate()
  }
  const parts: BufferGeometry[] = []
  const radii: number[] = []
  for (const f of FINGERS) {
    const bones = [1, 2, 3, 4].map((k) => `${f}${k}${side}`)
    const js = chain(rig, bones, 0.85)
    if (!js) {
      continue
    }
    const r = [0, 1, 2].map((s) => {
      const a = js[s]
      const b = js[s + 1]
      const len = a && b ? a.distanceTo(b) : 0.02
      const fall = len * 0.42
      const m = a && b ? rig.radius(bones[s] ?? '', a, b, fall) : fall
      // a glove is a little fuller than the finger, never a sausage
      return Math.min(len * 0.55, Math.max(len * 0.3, m * 1.08))
    })
    radii.push(r[0] ?? 0.008)
    const g = digit(rig, { bones, joints: js, wrist: wristBone, up, radii: r, flat: 0.86 })
    if (g) {
      parts.push(g)
    }
  }
  const fingerR = radii.reduce((a, b) => a + b, 0) / Math.max(1, radii.length)
  const tb = [1, 2, 3, 4].map((k) => `Thumb${k}${side}`)
  const tj = chain(rig, tb, 0.95)
  if (!tj) {
    return null
  }
  const tr = [0, 1, 2].map((s) => {
    const a = tj[s]
    const b = tj[s + 1]
    const len = a && b ? a.distanceTo(b) : 0.025
    const m = a && b ? rig.radius(tb[s] ?? '', a, b, fingerR * 1.15) : fingerR * 1.15
    // the ball of the thumb is the fullest part of the hand
    const k = s === 0 ? 1.45 : 1.12
    return Math.min(len * 0.6, Math.max(fingerR * k, m))
  })
  const thumb = digit(rig, { bones: tb, joints: tj, wrist: wristBone, up, radii: tr, flat: 0.9 })
  const foreBone = Math.max(0, rig.index(`LowerArm${side}`))
  const p = palm(rig, side, { wrist, knuckles, across, up, wristBone, foreBone }, fingerR)
  if (!(thumb && p)) {
    return null
  }
  parts.push(thumb, p)
  return mergeGeometries(parts, false)
}

/** The body's hand and cuff vertices on each side: tinted cuffs, and which triangles to drop. */
function cuffsAndHands(g: BufferGeometry, skeleton: Skeleton, gloved: ReadonlySet<Side>): void {
  const idx = g.getAttribute('skinIndex') as BufferAttribute | undefined
  const w = g.getAttribute('skinWeight') as BufferAttribute | undefined
  const color = g.getAttribute('color') as BufferAttribute | undefined
  const mat = g.getAttribute('styMat') as BufferAttribute | undefined
  const lum = g.getAttribute('styLum') as BufferAttribute | undefined
  if (!(idx && w)) {
    return
  }
  const hand = skeleton.bones.map((b) => HAND.test(b.name))
  const sideOf = skeleton.bones.map((b) => (b.name.endsWith('L') ? 'L' : 'R'))
  const under = new Uint8Array(idx.count)
  for (let v = 0; v < idx.count; v++) {
    let onHand = 0
    let side: Side = 'R'
    for (let k = 0; k < 4; k++) {
      const bone = idx.getComponent(v, k)
      const wt = w.getComponent(v, k)
      if (hand[bone]) {
        onHand += wt
        side = sideOf[bone] === 'L' ? 'L' : 'R'
      }
    }
    // every vertex the hand pulls at all (the seam under the glove's cuff included): leather, so
    // no sliver of the source hand's skin shows past the cuff at a grazing angle
    if (onHand > 0.04) {
      color?.setXYZ(v, LEATHER[0], LEATHER[1], LEATHER[2])
      mat?.setXY(v, GLOVE_MAT[0], GLOVE_MAT[1])
      lum?.setX(v, 0)
    }
    if (gloved.has(side)) {
      under[v] = Math.round(Math.min(1, onHand) * 100)
    }
  }
  if (color) {
    color.needsUpdate = true
  }
  // the source hand under a glove: its triangles go
  const ix = g.getIndex()
  if (ix && gloved.size > 0) {
    const keep: number[] = []
    for (let t = 0; t < ix.count; t += 3) {
      const a = ix.getX(t)
      const b = ix.getX(t + 1)
      const c = ix.getX(t + 2)
      // (any triangle mostly on the hand: the wrist's seam is under the glove's cuff)
      if ((under[a] ?? 0) + (under[b] ?? 0) + (under[c] ?? 0) < 40) {
        keep.push(a, b, c)
      }
    }
    g.setIndex(keep)
  }
}

/** The gloves' leather (one material for both hands). */
function gloveMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    name: 'VmGlove',
    color: GLOVE_COLOR,
    roughness: 0.5,
    // the cuff's mouth and the tubes' ends are seen from inside too
    side: DoubleSide,
    metalness: 0,
  })
}

/**
 * Dress the view model's body for the lens: gloves rebuilt on its hands (one skinned mesh beside
 * the body, on its skeleton), the cuffs tinted, the arms' normals smoothed.
 */
export function dressForLens(body: SkinnedMesh): void {
  const g = body.geometry.clone()
  const rig = new HandRig(g, body.skeleton, body.bindMatrixInverse)
  const gloves: BufferGeometry[] = []
  const gloved = new Set<Side>()
  for (const side of ['R', 'L'] as const) {
    const glove = gloveGeometry(rig, side)
    if (glove) {
      gloves.push(glove)
      gloved.add(side)
    }
  }
  cuffsAndHands(g, body.skeleton, gloved)
  body.geometry = toCreasedNormals(g, CREASE)
  g.dispose()
  const merged = gloves.length > 0 ? mergeGeometries(gloves, false) : null
  if (!(merged && body.parent)) {
    return
  }
  const mesh = new SkinnedMesh(merged, gloveMaterial())
  mesh.name = 'vm-gloves'
  mesh.frustumCulled = false
  mesh.position.copy(body.position)
  mesh.quaternion.copy(body.quaternion)
  mesh.scale.copy(body.scale)
  mesh.bindMode = body.bindMode
  mesh.bind(body.skeleton, body.bindMatrix)
  body.parent.add(mesh)
}
