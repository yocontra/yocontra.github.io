// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * Perdition's clock tower, after the Quick Draw courthouse tower (scene/clocktower.ts) at
 * Frontier's budget: no textures of its own, only the town's merged batches. Brick shaft with
 * pale quoins and bands, a dial on every face, an open belfry with its bell, and a bell-cast
 * shingled spire with lucarnes and a finial (the roof batch, so it fades like every roof).
 */
import { BufferAttribute, type BufferGeometry, CylinderGeometry, Vector3 } from 'three'
import { GeoBuilder } from '../../scene/geo.ts'
import type { Building } from '../sim/layout.ts'

export interface TowerBatches {
  stone: GeoBuilder
  wood: GeoBuilder
  windows: GeoBuilder
  roofs: BufferGeometry[]
  extra: BufferGeometry[]
}

const BRICK = 0xc8_6c_52
const PALE = 0xf2_e8_d6
const DIAL = 0xf4_e8_c8
const IRON = 0x1e_1a_16
const SHINGLE = 0xb8_a0_84
const DARK = 0x2a_20_18

const SHAFT = 10.2
const BELFRY0 = 10.5
const BELFRY1 = 13.6
const TIP = 19.6

/** Points on a tower face k (0 = south/+z, then clockwise from above) in face-local a, y, out. */
function onFace(cx: number, cz: number, k: number, a: number, y: number, out: number): Vector3 {
  const v = new Vector3(a, y, out).applyAxisAngle(new Vector3(0, 1, 0), (k * Math.PI) / 2)
  return v.add(new Vector3(cx, 0, cz))
}

/** A box on face k: centred at (a, y), `w` x `h` on the face, from `d0` to `d1` out of the axis. */
function faceBox(
  g: GeoBuilder,
  cx: number,
  cz: number,
  k: number,
  a: number,
  y: number,
  w: number,
  h: number,
  d0: number,
  d1: number,
  color: number,
): void {
  const c = onFace(cx, cz, k, a, y, (d0 + d1) / 2)
  const side = k % 2 === 1
  g.box(c.x, c.y, c.z, side ? d1 - d0 : w, h, side ? w : d1 - d0, color)
}

function quoins(g: GeoBuilder, cx: number, cz: number, half: number, y0: number, y1: number) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (let k = 0, y = y0; y < y1 - 0.1; k++, y += 0.42) {
        const lx = k % 2 === 1 ? 0.75 : 0.45
        const lz = k % 2 === 1 ? 0.45 : 0.75
        const top = Math.min(y + 0.42, y1)
        g.box(
          cx + sx * (half - lx / 2 + 0.03),
          (y + top) / 2,
          cz + sz * (half - lz / 2 + 0.03),
          lx + 0.06,
          top - y - 0.03,
          lz + 0.06,
          PALE,
        )
      }
    }
  }
}

/** A clock dial on face k: pale surround, a 16-gon dial in the window batch, iron hands. */
function dial(t: TowerBatches, cx: number, cz: number, k: number, half: number): void {
  const y = 8.95
  faceBox(t.stone, cx, cz, k, 0, y, 2.4, 2.3, half - 0.1, half + 0.08, PALE)
  const out = half + 0.1
  const r = 0.95
  const n = 16
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    t.windows.tri(
      onFace(cx, cz, k, 0, y, out),
      onFace(cx, cz, k, Math.cos(a0) * r, y + Math.sin(a0) * r, out),
      onFace(cx, cz, k, Math.cos(a1) * r, y + Math.sin(a1) * r, out),
      DIAL,
    )
  }
  // hands at ten to two, and a dark bezel
  faceBox(t.wood, cx, cz, k, -0.2, y + 0.18, 0.5, 0.08, out, out + 0.04, IRON)
  faceBox(t.wood, cx, cz, k, 0.22, y + 0.3, 0.5, 0.07, out, out + 0.05, IRON)
  faceBox(t.wood, cx, cz, k, 0, y + r + 0.04, 2.0, 0.08, out - 0.05, out + 0.03, IRON)
  faceBox(t.wood, cx, cz, k, 0, y - r - 0.04, 2.0, 0.08, out - 0.05, out + 0.03, IRON)
}

/** The open belfry: corner piers, stepped arch heads, sills with rails, floor and bell. */
function belfry(t: TowerBatches, cx: number, cz: number, half: number): void {
  const bh = half - 0.2
  const pier = 0.75
  const ow = bh * 2 - pier * 2
  for (let k = 0; k < 4; k++) {
    for (const s of [-1, 1]) {
      faceBox(
        t.stone,
        cx,
        cz,
        k,
        s * (bh - pier / 2),
        (BELFRY0 + BELFRY1) / 2,
        pier,
        BELFRY1 - BELFRY0,
        bh - 0.5,
        bh,
        BRICK,
      )
    }
    // the arch head, stepped in three courses
    faceBox(t.stone, cx, cz, k, 0, BELFRY1 - 0.35, ow, 0.7, bh - 0.5, bh, BRICK)
    for (const [w, y] of [
      [ow - 0.5, BELFRY1 - 0.82],
      [ow - 1.1, BELFRY1 - 1.05],
    ] as const) {
      for (const s of [-1, 1]) {
        const step = (ow - w) / 2
        faceBox(t.stone, cx, cz, k, s * (ow / 2 - step / 2), y, step, 0.24, bh - 0.5, bh, BRICK)
      }
    }
    faceBox(t.stone, cx, cz, k, 0, BELFRY0 + 0.25, ow, 0.5, bh - 0.5, bh + 0.08, PALE)
    faceBox(t.wood, cx, cz, k, 0, BELFRY0 + 0.95, ow, 0.1, bh - 0.3, bh - 0.18, 0xe0_d4_bc)
  }
  t.wood.box(cx, BELFRY0 + 0.05, cz, bh * 2 - 0.6, 0.1, bh * 2 - 0.6, DARK)
  t.wood.box(cx, BELFRY0 + 2.5, cz, 2.2, 0.22, 0.26, DARK)
  const bell = new CylinderGeometry(0.32, 0.72, 1.1, 14, 1).translate(cx, BELFRY0 + 1.85, cz)
  t.wood.box(cx, BELFRY0 + 2.48, cz, 0.3, 0.16, 0.3, 0x9a_74_40)
  const col = new Float32Array(bell.getAttribute('position').count * 3)
  for (let i = 0; i < col.length; i += 3) {
    col.set([0.62, 0.46, 0.25], i)
  }
  bell.setAttribute('color', new BufferAttribute(col, 3))
  t.extra.push(bell.toNonIndexed())
}

/** Bell-cast spire with four gabled lucarnes and a finial, tagged for the roof fade. */
function spire(t: TowerBatches, cx: number, cz: number, half: number, id: number): void {
  const roof = new GeoBuilder(2)
  const rings: [number, number][] = [
    [BELFRY1 + 0.3, half + 0.45],
    [BELFRY1 + 0.75, half - 0.1],
  ]
  const y0 = BELFRY1 + 0.75
  for (let i = 1; i <= 8; i++) {
    const s = i / 8
    rings.push([y0 + (TIP - y0) * s, 0.1 + (half - 0.2) * (1 - s) ** 1.5])
  }
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i + 1 < rings.length; i++) {
      const [ya, ha] = rings[i] as [number, number]
      const [yb, hb] = rings[i + 1] as [number, number]
      roof.quad(
        onFace(cx, cz, k, -ha, ya, ha),
        onFace(cx, cz, k, ha, ya, ha),
        onFace(cx, cz, k, hb, yb, hb),
        onFace(cx, cz, k, -hb, yb, hb),
        SHINGLE,
        k % 2 === 1,
      )
    }
    const y = BELFRY1 + 1.9
    const [ra, rh] = rings[2] as [number, number]
    const [rb, rh2] = rings[3] as [number, number]
    const hw = rh + ((rh2 - rh) * (y - ra)) / (rb - ra)
    faceBox(roof, cx, cz, k, 0, y, 1.0, 1.0, hw - 0.9, hw + 0.55, SHINGLE)
    faceBox(t.wood, cx, cz, k, 0, y - 0.05, 0.7, 0.75, hw + 0.4, hw + 0.58, DARK)
    const c = onFace(cx, cz, k, 0, y + 0.5, hw - 0.15)
    roof.gable(c.x, c.y, c.z, 1.05, 1.05, 0.45, k % 2 === 1 ? 'x' : 'z', SHINGLE, 0.05)
  }
  roof.box(cx, TIP + 0.1, cz, 0.36, 0.3, 0.36, IRON)
  roof.box(cx, TIP + 0.45, cz, 0.4, 0.4, 0.4, 0xc8_a0_58)
  roof.box(cx, TIP + 1.2, cz, 0.08, 1.2, 0.08, IRON)
  roof.box(cx, TIP + 1.45, cz, 1.2, 0.06, 0.12, IRON)
  const rg = roof.build()
  rg.setAttribute(
    'bid',
    new BufferAttribute(new Float32Array(rg.getAttribute('position').count).fill(id), 1),
  )
  t.roofs.push(rg)
}

/** The whole tower on its layout footprint; `id` is its roof-fade building id. */
export function addClockTower(t: TowerBatches, b: Building, id: number): void {
  const cx = b.x + b.w / 2
  const cz = b.z + b.d / 2
  const half = Math.min(b.w, b.d) / 2
  t.stone.box(cx, 0.4, cz, half * 2 + 0.2, 0.8, half * 2 + 0.2, PALE, { skip: ['bottom'] })
  t.stone.box(cx, (0.8 + SHAFT) / 2, cz, half * 2, SHAFT - 0.8, half * 2, BRICK, {
    skip: ['bottom'],
  })
  for (const [y, h, p] of [
    [4.6, 0.22, 0.06],
    [7.6, 0.22, 0.08],
    [SHAFT + 0.12, 0.24, 0.2],
    [SHAFT + 0.32, 0.18, 0.34],
    [BELFRY1 + 0.12, 0.24, 0.2],
  ] as const) {
    t.stone.box(cx, y, cz, half * 2 + p * 2, h, half * 2 + p * 2, PALE)
  }
  quoins(t.stone, cx, cz, half, 0.8, SHAFT)
  for (let k = 0; k < 4; k++) {
    dial(t, cx, cz, k, half)
  }
  belfry(t, cx, cz, half)
  spire(t, cx, cz, half, id)
}
