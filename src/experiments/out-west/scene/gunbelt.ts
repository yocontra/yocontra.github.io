// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * The gunbelt and holster leather, built where scene/holster.ts fitted them, and the guns hung
 * in it. Every piece is baked into his one skinned mesh (no extra draw): the belt is skinned like
 * the hips under it, each holster sleeve rides its thigh bone rigidly (as the gun in it does), and
 * each drop strap blends from the belt at the top to the thigh at the bottom.
 */
import {
  type Bone,
  BufferAttribute,
  BufferGeometry,
  Color,
  type Group,
  Matrix4,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import type { Piece } from './bake.ts'
import { type Body, bounds, nearestWeights, onBones, reach, type WeightFn } from './fit.ts'
import {
  BELT_T,
  BELT_W,
  type BeltFit,
  EASE,
  fitBelt,
  type GunAnatomy,
  gunAnatomy,
  type HolsterFit,
  hipSurface,
  LEATHER,
} from './holster.ts'
import { type HolsterLook, mergedProp } from './kit.ts'
import type { Fit } from './outfit.ts'
import { slotOn } from './rig.ts'
import { FABRIC } from './style.ts'

const lin = (hex: number): Color => new Color(hex)

interface Build {
  pos: number[]
  col: number[]
  uv: number[]
  idx: number[]
}

const newBuild = (): Build => ({ pos: [], col: [], uv: [], idx: [] })

function toGeo(b: Build): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3))
  g.setAttribute('color', new BufferAttribute(new Float32Array(b.col), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(b.uv), 2))
  g.setIndex(b.idx)
  g.computeVertexNormals()
  return g
}

/** A grid of rows × cols vertices (row-major) as quads, facing out when `flip` is false. */
function grid(
  b: Build,
  o: { start: number; rows: number; cols: number; wrap: boolean; flip: boolean },
): void {
  const { start, rows, cols, wrap, flip } = o
  const c = wrap ? cols : cols - 1
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < c; j++) {
      const j1 = (j + 1) % cols
      const p = start + i * cols + j
      const q = start + i * cols + j1
      const r = start + (i + 1) * cols + j
      const s = start + (i + 1) * cols + j1
      if (flip) {
        b.idx.push(p, q, r, q, s, r)
      } else {
        b.idx.push(p, r, q, q, r, s)
      }
    }
  }
}

const leather = (k: keyof typeof FABRIC = 'leather') => ({
  roughness: 1,
  rim: FABRIC[k].rim,
  swatch: FABRIC[k].swatch,
})

/**
 * The holster sleeve, in the gun's own frame: closed at the toe past the muzzle, open at the
 * mouth around the cylinder, every ring sized from the gun inside it (plus room and leather).
 */
function sleeve(a: GunAnatomy, color: Color, trim: Color | null): Build[] {
  const b = newBuild()
  const segs = 10
  const x0 = a.mouthX
  const x1 = a.muzzle.x + 0.012
  const n = 7
  const rings: { x: number; cy: number; ry: number; rz: number }[] = []
  const c0 = a.cylinder
  const c1 = a.barrel
  for (let i = 0; i <= n; i++) {
    // eased from the cylinder's girth at the mouth to the barrel's by the middle, then straight
    const t = Math.min(1, (i / n) * 2)
    const k = t * t * (3 - 2 * t)
    const mix = (u: number, v: number) => u + (v - u) * k
    rings.push({
      x: x0 + ((x1 - x0) * i) / n,
      cy: mix(c0.cy, c1.cy),
      ry: mix(c0.hy, c1.hy) + EASE + LEATHER,
      rz: mix(c0.hz, c1.hz) + EASE + LEATHER,
    })
  }
  const first = rings[0]
  if (first) {
    first.ry *= 1.08
    first.rz *= 1.12
  }
  for (const [i, r] of rings.entries()) {
    for (let j = 0; j < segs; j++) {
      const t = (j / segs) * Math.PI * 2
      b.pos.push(r.x, r.cy + Math.cos(t) * r.ry, Math.sin(t) * r.rz)
      b.col.push(color.r, color.g, color.b)
      b.uv.push(j / segs, i / n)
    }
  }
  grid(b, { start: 0, rows: rings.length, cols: segs, wrap: true, flip: true })
  // the toe cap
  const last = rings.at(-1)
  if (last) {
    const tip = b.pos.length / 3
    b.pos.push(last.x + 0.008, last.cy, 0)
    b.col.push(color.r, color.g, color.b)
    b.uv.push(0.5, 1)
    const base = (rings.length - 1) * segs
    for (let j = 0; j < segs; j++) {
      b.idx.push(base + j, base + ((j + 1) % segs), tip)
    }
  }
  const out = [b]
  if (trim && first && last) {
    // a tooled band at the mouth and at the toe
    for (const [r, w] of [
      [first, 0.012],
      [rings[n - 1] ?? last, 0.01],
    ] as const) {
      const t = newBuild()
      for (const dx of [0, w]) {
        for (let j = 0; j < segs; j++) {
          const a2 = (j / segs) * Math.PI * 2
          t.pos.push(r.x + dx, r.cy + Math.cos(a2) * (r.ry + 0.002), Math.sin(a2) * (r.rz + 0.002))
          t.col.push(trim.r, trim.g, trim.b)
          t.uv.push(j / segs, dx / w)
        }
      }
      grid(t, { start: 0, rows: 2, cols: segs, wrap: true, flip: true })
      out.push(t)
    }
  }
  return out
}

/** Apply a root-space rigid transform to a build's positions. */
function place(b: Build, m: Matrix4): BufferGeometry {
  const g = toGeo(b)
  g.applyMatrix4(m)
  g.computeVertexNormals()
  return g
}

/**
 * The gunbelt: a band around his hips over everything he wears there, sloping down to each
 * holster; a buckle in front and cartridge loops round the back.
 */
function beltBand(
  pts: readonly Vector3[],
  fit: BeltFit,
  o: { cx: number; cz: number; color: Color; brass: Color; buckle: Color; width: number },
): Build[] {
  const segs = 36
  const yAt = (a: number): number => {
    let y = fit.y
    for (const h of fit.holsters) {
      // his right side is -X: angle -π/2 from +Z toward +X
      const c = Math.cos(a - (h.side === 1 ? -Math.PI / 2 : Math.PI / 2))
      y -= Math.max(0, c) ** 2 * fit.sag
    }
    return y
  }
  const sample = pts.map((p) => ({ p, bone: '', mat: '', w: [] as const }))
  const radii: number[] = []
  for (let j = 0; j < segs; j++) {
    const a = (j / segs) * Math.PI * 2
    const r = reach(sample, { cx: o.cx, cz: o.cz, y: yAt(a), a, dy: o.width / 2, da: 0.2 })
    radii.push(r)
  }
  const known = radii.filter((r) => Number.isFinite(r))
  const fallback = known.length > 0 ? Math.min(...known) : 0.14
  const filled = radii.map((r) => (Number.isFinite(r) ? r : fallback))
  // dilate then smooth: snug, never inside him
  const dil = filled.map((_, j) =>
    Math.max(filled[(j + segs - 1) % segs] ?? 0, filled[j] ?? 0, filled[(j + 1) % segs] ?? 0),
  )
  const rad = dil.map(
    (_, j) =>
      ((dil[(j + segs - 1) % segs] ?? 0) + 2 * (dil[j] ?? 0) + (dil[(j + 1) % segs] ?? 0)) / 4 +
      0.004,
  )
  const band = newBuild()
  // four rows: inner top, outer top, outer bottom, inner bottom (a flat strap with an edge)
  const rows: [number, number][] = [
    [0, o.width / 2],
    [BELT_T, o.width / 2],
    [BELT_T, -o.width / 2],
    [0, -o.width / 2],
  ]
  for (const [ri, [dr, dy]] of rows.entries()) {
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2
      const r = (rad[j] ?? fallback) + dr
      band.pos.push(o.cx + Math.sin(a) * r, yAt(a) + dy, o.cz + Math.cos(a) * r)
      band.col.push(o.color.r, o.color.g, o.color.b)
      band.uv.push((j / segs) * 6, ri / 3)
    }
  }
  grid(band, { start: 0, rows: rows.length, cols: segs, wrap: true, flip: false })
  const out = [band]
  // the buckle on his belly, the loops on his back
  const studs = newBuild()
  const stud = (q: { a: number; w: number; h: number; c: Color; lift: number }): void => {
    const { a, w, h, c, lift } = q
    const j = Math.round((a / (Math.PI * 2)) * segs + segs) % segs
    const r = (rad[j] ?? fallback) + BELT_T + lift
    const y = yAt(a)
    const s = studs.pos.length / 3
    const tx = Math.cos(a)
    const tz = -Math.sin(a)
    const nx = Math.sin(a)
    const nz = Math.cos(a)
    for (const [u, v, d] of [
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ] as const) {
      studs.pos.push(
        o.cx + nx * (r - BELT_T * 0.5 + d * lift) + tx * u * w,
        y + v * h,
        o.cz + nz * (r - BELT_T * 0.5 + d * lift) + tz * u * w,
      )
      studs.col.push(c.r, c.g, c.b)
      studs.uv.push((u + 1) / 2, (v + 1) / 2)
    }
    for (const f of [
      [4, 5, 6, 7],
      [1, 0, 3, 2],
      [0, 4, 7, 3],
      [5, 1, 2, 6],
      [7, 6, 2, 3],
      [0, 1, 5, 4],
    ]) {
      const [i0, i1, i2, i3] = f.map((k) => s + k) as [number, number, number, number]
      studs.idx.push(i0, i1, i2, i0, i2, i3)
    }
  }
  stud({ a: 0, w: o.width * 0.55, h: o.width * 0.5, c: o.buckle, lift: 0.006 })
  for (let k = 0; k < 9; k++) {
    stud({
      a: Math.PI * (0.62 + (0.76 * k) / 8),
      w: 0.006,
      h: o.width * 0.36,
      c: o.brass,
      lift: 0.005,
    })
  }
  out.push(studs)
  return out
}

/**
 * The drop strap: a flat tongue of leather from the belt down the outside of his thigh to the
 * holster's mouth, lying between the thigh and the gun.
 */
function dropStrap(h: HolsterFit, color: Color, width: number): Build {
  const b = newBuild()
  const { top, bottom, out } = h.strap
  const along = bottom.clone().sub(top)
  const fwd = new Vector3(0, 0, 1)
  const rows = 4
  for (let i = 0; i <= rows; i++) {
    const t = i / rows
    const c = top
      .clone()
      .addScaledVector(along, t)
      .addScaledVector(out, LEATHER * 0.4)
    for (const [k, s] of [-1, 1].entries()) {
      const p = c.clone().addScaledVector(fwd, (s * width) / 2)
      b.pos.push(p.x, p.y, p.z)
      b.col.push(color.r, color.g, color.b)
      b.uv.push(k, t)
    }
  }
  grid(b, { start: 0, rows: rows + 1, cols: 2, wrap: false, flip: h.side === -1 })
  return b
}

/**
 * Every piece of leather and brass for the gunbelt and holsters, as bake pieces: the belt rides
 * his hips (weighted like the hips under it), each sleeve rides its thigh bone rigidly (as the
 * gun in it does), and each drop strap blends from the belt's weights at the top to the thigh's
 * at the bottom.
 */
export function gunbeltPieces(
  body: Body,
  clothes: readonly Piece[],
  fit: BeltFit,
  o: {
    look: HolsterLook
    a: GunAnatomy
    bone: (name: string) => Bone | null
    hips: Vector3
    scale: number
  },
): Piece[] {
  const color = lin(o.look.color)
  const trim = o.look.trim === undefined ? null : lin(o.look.trim)
  const brass = lin(0xc8_a0_50)
  const pts = hipSurface(body, clothes)
  const width = BELT_W * o.scale * (o.look.rig ? 1.25 : 1)
  const beltW = nearestWeights(body, onBones(body, ['Hips', 'Abdomen']))
  const out: Piece[] = []
  for (const g of beltBand(pts, fit, {
    cx: o.hips.x,
    cz: bounds(onBones(body, ['Hips'])).center.z,
    color,
    brass,
    buckle: trim ?? lin(0xb8_b0_a0),
    width,
  })) {
    out.push({ geo: toGeo(g), ...leather(), weights: beltW })
  }
  for (const h of fit.holsters) {
    const legBone = o.bone(h.side === 1 ? 'UpperLegR' : 'UpperLegL')
    if (!legBone) {
      continue
    }
    const leg: WeightFn = () => [[legBone, 1]]
    const m = new Matrix4().compose(h.pos, h.quat, new Vector3(1, 1, 1))
    for (const s of sleeve(o.a, color, trim)) {
      out.push({ geo: place(s, m), ...leather(), weights: leg })
    }
    const strap = toGeo(dropStrap(h, color, width * (o.look.rig ? 1.6 : 1.1)))
    const top = h.strap.top.y
    const bot = h.strap.bottom.y
    out.push({
      geo: strap,
      ...leather(),
      weights: (p) => {
        const t = Math.min(1, Math.max(0, (top - p.y) / Math.max(1e-3, top - bot)))
        return [...beltW(p).map(([b, w]) => [b, w * (1 - t)] as const), [legBone, t] as const]
      },
    })
  }
  return out
}

/** The guns he carries, hung in their holsters, and the leather to bake. */
export interface Hung {
  pieces: Piece[]
  anatomy: GunAnatomy
  gun: Object3D
  holster: Group | null
  offGun: Object3D | null
  offHolster: Group | null
}

/**
 * Fit the gunbelt and holster(s) to him (`fitBelt`), build the leather, and hang a revolver in
 * each holster on the thigh bone it rides. `gun` is the revolver he carries, finished (a
 * Buntline's longer barrel gets a longer holster). Null when he has no legs to hang it on.
 */
export function hangGuns(
  f: Fit,
  o: {
    gun: Object3D
    two: boolean
    clothes: readonly Piece[]
    look: HolsterLook
    scale: number
    bone: (name: string) => Bone | null
    root: Object3D
  },
): Hung | null {
  const gun = mergedProp(o.gun)
  const anatomy = gunAnatomy(gun)
  const fit = fitBelt(f.body, o.clothes, o.bone, {
    sides: o.two ? [1, -1] : [1],
    a: anatomy,
    root: o.root,
  })
  if (!fit) {
    return null
  }
  const rootQ = o.root.getWorldQuaternion(new Quaternion())
  const hang = (h: HolsterFit | undefined, g: Object3D): Group | null => {
    const b = h ? (o.bone(h.side === 1 ? 'UpperLegR' : 'UpperLegL') ?? o.bone('Hips')) : null
    if (!(h && b)) {
      return null
    }
    const slot = slotOn(b, o.root.localToWorld(h.pos.clone()), rootQ.clone().multiply(h.quat))
    slot.add(g)
    return slot
  }
  const [right, left] = fit.holsters
  const offGun = o.two && left ? mergedProp(o.gun) : null
  const inv = o.root.matrixWorld.clone().invert()
  return {
    pieces: gunbeltPieces(f.body, o.clothes, fit, {
      look: o.look,
      a: anatomy,
      bone: o.bone,
      hips: f.at('Hips').applyMatrix4(inv),
      scale: o.scale,
    }),
    anatomy,
    gun,
    holster: hang(right, gun),
    offGun,
    offHolster: offGun ? hang(left, offGun) : null,
  }
}
