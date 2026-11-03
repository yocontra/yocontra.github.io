/**
 * Hats: the lathed felt hats, and how one is fitted to a head.
 *
 * Every hat is built to the same crown opening (OPENING_R front to back, an oval OVAL as broad as
 * it is long, like a real hat), so a fit depends on the head and never on the hat. The fit is
 * measured on the skinned surface in the pose he is dressed in (see fit.ts):
 * - the seat is the height on his skull where a hat band rides (a fixed share of the way from his
 *   eyes to the top of his skull, not of his hair);
 * - the scale makes the opening hug the skull (plus a little hair) at the seat, then grows only
 *   until the crown clears the skull above it;
 * - hair that would poke through the crown or the brim is tucked under it (`tuckHair`).
 *
 * The VAT crowd reads the same fit through the near actor's hat transform (crowd/vat.ts).
 */
import {
  type BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  SplineCurve,
  Vector2,
} from 'three'
import type { HatKey } from '../data/outlaws.ts'
import { mergePieces, meshPieces, type Piece } from './bake.ts'
import type { Body } from './fit.ts'
import { characterMaterial } from './shade.ts'
import type { Floor } from './style.ts'

/** Hat silhouettes from lathe profiles (x = radius, y = height), metres, crown top first. */
const HAT_PROFILES: Record<HatKey, [number, number][]> = {
  cowboy: [
    [0.0, 0.128],
    [0.06, 0.133],
    [0.086, 0.11],
    [0.1, 0.03],
    [0.12, 0.012],
    [0.17, 0.0],
    [0.205, 0.02],
    [0.215, 0.045],
  ],
  bowler: [
    [0.0, 0.125],
    [0.06, 0.118],
    [0.092, 0.08],
    [0.1, 0.02],
    [0.13, 0.008],
    [0.148, 0.02],
  ],
  sombrero: [
    [0.0, 0.2],
    [0.05, 0.19],
    [0.08, 0.1],
    [0.1, 0.02],
    [0.25, 0.0],
    [0.34, 0.02],
    [0.36, 0.07],
  ],
  tophat: [
    [0.0, 0.2],
    [0.088, 0.2],
    [0.082, 0.1],
    [0.09, 0.012],
    [0.13, 0.0],
    [0.145, 0.018],
  ],
  tall: [
    [0.0, 0.2],
    [0.05, 0.205],
    [0.08, 0.18],
    [0.095, 0.03],
    [0.12, 0.012],
    [0.17, 0.0],
    [0.215, 0.012],
    [0.225, 0.035],
  ],
  flat: [
    [0.0, 0.095],
    [0.095, 0.095],
    [0.1, 0.02],
    [0.13, 0.006],
    [0.185, 0.0],
    [0.19, 0.012],
  ],
}

/** Index of the profile point where the crown meets the brim (the opening). */
const OPENING_AT: Record<HatKey, number> = {
  cowboy: 3,
  bowler: 3,
  sombrero: 3,
  tophat: 3,
  tall: 3,
  flat: 2,
}

/** Every hat's crown opening, front to back (radius, metres), before it is fitted. */
const OPENING_R = 0.1
/** Crown breadth over length: heads (and hat crowns) are ovals. The brim keeps its width all round. */
const OVAL = 0.86
/** The band rides this share of the way from his eyes to the top of his skull. */
const SEAT = 0.42
/** Hair counted into the band's girth; more than this is pressed flat under the felt. */
const HAIR_GIRTH = 0.008
/** Room between the head and the felt. */
const EASE = 0.006
/** Brim tilt back, radians. */
const TILT = 0.06
/** Materials that are not skull (hair is fitted separately; eyes and brows sit below the seat). */
const NOT_SKULL = new Set(['Hair', 'Brows', 'Eye', 'Beard'])
/** Per-hat crease and brim curl (metres, before normalising). */
const CURL: Partial<Record<HatKey, number>> = { cowboy: 0.05, tall: 0.045, sombrero: 0.02 }
const CREASE: Partial<Record<HatKey, number>> = { cowboy: 0.022, tall: 0.018 }
/**
 * How much of each profile's brim width (beyond the crown) is kept. At full width every brim
 * stuck out past his shoulders and the hats read far too large.
 */
const BRIM: Partial<Record<HatKey, number>> = { sombrero: 0.8 }
const brimK = (key: HatKey) => BRIM[key] ?? 0.7

/** A hat's profile scaled so its opening is OPENING_R. */
function profile(key: HatKey): { pts: [number, number][]; open: number; k: number } {
  const src = HAT_PROFILES[key] ?? HAT_PROFILES.cowboy
  const open = OPENING_AT[key] ?? 3
  const k = OPENING_R / (src[open]?.[0] ?? OPENING_R)
  return { pts: src.map(([x, y]) => [x * k, y * k]), open, k }
}

/** Crown geometry in the normalised hat: the opening's height, the inner top, the wall radius. */
interface Crown {
  openY: number
  topY: number
  /** Radius of the crown wall at hat height `y` (front to back; the side is OVAL of it). */
  wall: (y: number) => number
}

const crowns = new Map<HatKey, Crown>()

function crown(key: HatKey): Crown {
  const have = crowns.get(key)
  if (have) {
    return have
  }
  const { pts, open, k } = profile(key)
  // the wall: crown top down to the opening, as rising-y segments
  const wallPts = pts.slice(0, open + 1).reverse()
  const openY = wallPts[0]?.[1] ?? 0
  const top = Math.max(...wallPts.map(([, y]) => y))
  const c: Crown = {
    openY,
    // the crease presses the top in; the spline rounds the corners a little inside the polyline
    topY: top - (CREASE[key] ?? 0) * k - 0.008,
    wall: (y) => {
      for (let i = 0; i + 1 < wallPts.length; i++) {
        const [x0, y0] = wallPts[i] ?? [0, 0]
        const [x1, y1] = wallPts[i + 1] ?? [0, 0]
        if (y <= y1 || i + 2 === wallPts.length) {
          const t = Math.min(1, Math.max(0, (y - y0) / Math.max(1e-6, y1 - y0)))
          return (x0 + (x1 - x0) * t) * 0.96
        }
      }
      return OPENING_R
    },
  }
  crowns.set(key, c)
  return c
}

/**
 * Give a lathed hat its hand-made shape: a cattleman's brim rolls up at the sides and dips front
 * and back, and its crown takes a centre crease; the flat-brims keep theirs flat. Then the oval:
 * the crown is pressed in at the sides to OVAL, and the brim keeps its width all round.
 */
function shapeHat(geo: BufferGeometry, key: HatKey, lathe: boolean): void {
  const { pts } = profile(key)
  const brimR = Math.max(...pts.map(([x]) => x))
  const top = Math.max(...pts.map(([, y]) => y))
  const { k } = profile(key)
  const brim = brimK(key)
  const curl = (CURL[key] ?? 0) * k * brim
  const crease = (CREASE[key] ?? 0) * k
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    let y = pos.getY(i)
    const rr = Math.hypot(x, z)
    if (lathe && rr > OPENING_R + 0.008 && curl > 0) {
      const t = (rr - OPENING_R) / Math.max(0.01, brimR - OPENING_R)
      const side = (x / rr) ** 2
      y += curl * t * t * side - curl * 0.35 * t * t * (1 - side)
    }
    if (lathe && crease > 0 && y > top - 0.05) {
      const c = (y - (top - 0.05)) / 0.05
      y -= crease * c * Math.max(0, 1 - Math.abs(x) / (OPENING_R * 0.9))
    }
    // the oval: radius along this direction of an ellipse OVAL wide, 1 long
    if (rr > 1e-6) {
      const dx = x / rr
      const dz = z / rr
      const e = 1 / Math.hypot(dx / OVAL, dz)
      const r2 = rr <= OPENING_R ? rr * e : OPENING_R * e + (rr - OPENING_R) * brim
      pos.setX(i, dx * r2)
      pos.setZ(i, dz * r2)
    }
    pos.setY(i, y)
  }
  geo.computeVertexNormals()
}

/**
 * A hat as ONE mesh (crown and band merged, vertex coloured), its opening OPENING_R at the
 * origin's height `openY` (see `fitHat`). The returned group is what pops off; the fit scales
 * an inner child so popHat() keeps its size.
 */
export function makeHat(key: HatKey, color: number, floor: Floor = { value: 0 }): Group {
  const { pts: raw } = profile(key)
  const pts = raw.map(([x, y]) => new Vector2(x, y))
  // lathe needs the profile ordered bottom→top for outward normals; a spline through the
  // profile rounds the crown and the brim's roll instead of faceting them
  const prof = new SplineCurve([...pts].reverse()).getSpacedPoints(36)
  const g = new Group()
  const felt = new MeshStandardMaterial({ color, roughness: 0.85 })
  felt.userData.rim = 0.9
  felt.userData.swatch = 'felt'
  const lathe = new LatheGeometry(prof, 48)
  shapeHat(lathe, key, true)
  g.add(new Mesh(lathe, felt))
  // the band rides the crown wall just above the opening
  const c = crown(key)
  const bandH = key === 'sombrero' ? 0.03 : 0.022
  const bandY = c.openY + bandH / 2 + 0.004
  const r = c.wall(bandY) / 0.96
  const bandMat = new MeshStandardMaterial({
    color: new Color(color).multiplyScalar(0.35),
    roughness: 0.6,
  })
  bandMat.userData.swatch = 'leather'
  const bandGeo = new CylinderGeometry(r + 0.002, r + 0.004, bandH, 48, 1, true)
  bandGeo.translate(0, bandY, 0)
  shapeHat(bandGeo, key, false)
  g.add(new Mesh(bandGeo, bandMat))
  const geo = mergePieces(meshPieces(g, g))
  // the brim and the crown are single sheets: both faces show
  const mat = characterMaterial(floor, 'Felt')
  mat.side = DoubleSide
  const mesh = new Mesh(geo, mat)
  mesh.castShadow = true
  const out = new Group()
  const inner = new Group()
  inner.add(mesh)
  out.add(inner)
  // Crumple the brim a touch so it doesn't read as CG-perfect.
  out.rotation.z = (Math.random() - 0.5) * 0.06
  return out
}

/**
 * Where a hat sits on one man, in the actor's root space and the pose he was dressed in. The
 * crown is measured in his face's own frame (his head may be turned in that pose): `side` runs
 * from his right eye to his left, `fwd` out of his face.
 */
export interface HatFit {
  key: HatKey
  /** Crown centre over the skull. */
  cx: number
  cz: number
  /** Turn of his face about Y (radians; 0 = facing +Z like the root). */
  yaw: number
  /** Height of the band line (where the opening meets the skull). */
  seat: number
  /** Uniform scale of the normalised hat. */
  s: number
  /** Brim tilt back (radians, about his X axis). */
  tilt: number
  /** Height of the hat's origin (below the seat by the opening's height). */
  y: number
}

/** Ellipse-normalised distance from the crown axis: inside the crown when <= its wall radius. */
const oval = (u: number, w: number) => Math.hypot(u / OVAL, w)

/** A sample in the face frame: across (u), forward (w), relative to the crown centre. */
interface Frame {
  cx: number
  cz: number
  /** Unit side axis (his left, horizontal); forward is (-sz, sx). */
  sx: number
  sz: number
}

const across = (f: Frame, x: number, z: number) => (x - f.cx) * f.sx + (z - f.cz) * f.sz
const along = (f: Frame, x: number, z: number) => -(x - f.cx) * f.sz + (z - f.cz) * f.sx

/** His face's side axis from his two eyes (or the root's +X when the base has none). */
function faceSide(body: Body): { sx: number; sz: number } {
  const eyes = body.samples.filter((q) => q.mat === 'Eye')
  if (eyes.length < 2) {
    return { sx: 1, sz: 0 }
  }
  const mx = eyes.reduce((t, q) => t + q.p.x, 0) / eyes.length
  const l = { x: 0, z: 0, n: 0 }
  const r = { x: 0, z: 0, n: 0 }
  for (const q of eyes) {
    const e = q.p.x > mx ? l : r
    e.x += q.p.x
    e.z += q.p.z
    e.n++
  }
  if (l.n === 0 || r.n === 0) {
    return { sx: 1, sz: 0 }
  }
  const dx = l.x / l.n - r.x / r.n
  const dz = l.z / l.n - r.z / r.n
  const len = Math.hypot(dx, dz) || 1
  return { sx: dx / len, sz: dz / len }
}

/**
 * Fit hat `key` to the head in `body` (sampled in the pose he is dressed in); `eye` is the
 * height of his eyes. Pure measurement: nothing is moved.
 */
export function fitHat(body: Body, eye: number, key: HatKey): HatFit | null {
  const skull = body.samples.filter((q) => q.bone === 'Head' && !NOT_SKULL.has(q.mat))
  if (skull.length === 0) {
    return null
  }
  const hair = body.samples.filter((q) => q.mat === 'Hair')
  let top = Number.NEGATIVE_INFINITY
  for (const q of skull) {
    top = Math.max(top, q.p.y)
  }
  const seat = eye + SEAT * (top - eye)
  // the band: the skull's girth at the seat, in his face's frame, centred on it
  const band = skull.filter((q) => Math.abs(q.p.y - seat) < 0.012)
  const ring = band.length > 0 ? band : skull
  const side = faceSide(body)
  const f0: Frame = { cx: 0, cz: 0, ...side }
  let u0 = Number.POSITIVE_INFINITY
  let u1 = Number.NEGATIVE_INFINITY
  let w0 = Number.POSITIVE_INFINITY
  let w1 = Number.NEGATIVE_INFINITY
  for (const q of ring) {
    const u = across(f0, q.p.x, q.p.z)
    const w = along(f0, q.p.x, q.p.z)
    u0 = Math.min(u0, u)
    u1 = Math.max(u1, u)
    w0 = Math.min(w0, w)
    w1 = Math.max(w1, w)
  }
  const uc = (u0 + u1) / 2
  const wc = (w0 + w1) / 2
  const f: Frame = { cx: uc * side.sx - wc * side.sz, cz: uc * side.sz + wc * side.sx, ...side }
  const girthOf = (q: { p: { x: number; z: number } }) =>
    oval(across(f, q.p.x, q.p.z), along(f, q.p.x, q.p.z))
  let girth = 0
  for (const q of ring) {
    girth = Math.max(girth, girthOf(q))
  }
  // a little of his hair at the band counts; the rest is pressed under the felt
  let hairGirth = girth
  for (const q of hair) {
    if (Math.abs(q.p.y - seat) < 0.012) {
      hairGirth = Math.max(hairGirth, girthOf(q))
    }
  }
  const c = crown(key)
  let s = (Math.min(hairGirth, girth + HAIR_GIRTH) + EASE) / OPENING_R
  // grow only until the crown clears his skull above the band
  for (let it = 0; it < 24; it++) {
    const clear = skull.every((q) => {
      const h = q.p.y - seat
      const y = c.openY + h / s
      return h <= 0 || (y <= c.topY && girthOf(q) <= c.wall(y) * s)
    })
    if (clear) {
      break
    }
    s *= 1.02
  }
  return {
    key,
    cx: f.cx,
    cz: f.cz,
    yaw: Math.atan2(-side.sz, side.sx),
    seat,
    s,
    tilt: TILT,
    y: seat - c.openY * s,
  }
}

/**
 * Press the hair under a fitted hat: inside the crown (a little in from the felt) and under its
 * top, and in from the brim just under the band, so none of it shows through.
 */
export function tuckHair(pieces: readonly Piece[], fit: HatFit): void {
  const c = crown(fit.key)
  const ceiling = fit.seat + (c.topY - c.openY) * fit.s - 0.006
  const f: Frame = { cx: fit.cx, cz: fit.cz, sx: Math.cos(fit.yaw), sz: -Math.sin(fit.yaw) }
  for (const p of pieces) {
    if (p.name !== 'Hair') {
      continue
    }
    const pos = p.geo.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i) - fit.seat
      if (h < -0.025) {
        continue
      }
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const r = oval(across(f, x, z), along(f, x, z))
      const room = (h >= 0 ? c.wall(c.openY + h / fit.s) : OPENING_R) * fit.s * 0.94
      if (r > room) {
        pos.setX(i, fit.cx + ((x - fit.cx) * room) / r)
        pos.setZ(i, fit.cz + ((z - fit.cz) * room) / r)
      }
      if (pos.getY(i) > ceiling) {
        pos.setY(i, ceiling)
      }
    }
    pos.needsUpdate = true
  }
}
