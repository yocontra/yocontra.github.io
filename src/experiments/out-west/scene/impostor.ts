// biome-ignore-all lint/style/noMagicNumbers: silhouette proportions and colours, painted by eye to match the meshes in flora.ts
// biome-ignore-all lint/complexity/useMaxParams: canvas painters take positional numeric args (x, y, size…)
/**
 * Distant plants as impostors: each far saguaro, Joshua tree, ocotillo, shrub, snag or boulder is
 * two crossed, alpha-cut cards (4 triangles) showing a painted silhouette of its species. The
 * silhouettes are painted once at load on a small canvas atlas (512×256, no download), coloured
 * to match the procedural meshes, with the ribs, leaf clusters and twigs that read at 30 m+.
 * Cards are merged into a handful of static meshes; sway is skipped (it can't be seen that far).
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Uint32BufferAttribute,
} from 'three'
import { Rng } from '../ffa/sim/rng.ts'
import { withCloudShadow } from './atmos.ts'
import type { Plant, PlantKind } from './flora.ts'
import { releaseAfterUpload } from './release.ts'

const COLS = 8
const ROWS = 2
const CELL_W = 64
const CELL_H = 128

/** Atlas cells per species (several variants each). */
const CELLS: Partial<Record<PlantKind, readonly number[]>> = {
  saguaro: [0, 1, 2, 3],
  joshua: [4, 5],
  ocotillo: [6],
  snag: [7],
  creosote: [8, 9],
  sage: [10],
  cholla: [11],
  pear: [12],
  barrel: [13],
  boulder: [14, 15],
}

/** Card size per species (width, height) in metres, before the plant's own scale. */
const SIZE: Record<PlantKind, [number, number]> = {
  saguaro: [3.2, 8.5],
  joshua: [4.2, 5.2],
  ocotillo: [2.6, 4],
  snag: [3, 4],
  creosote: [2.6, 1.6],
  sage: [1.6, 1],
  cholla: [1.2, 1.6],
  pear: [1.6, 1.1],
  barrel: [0.9, 0.9],
  grass: [0.7, 0.5],
  boulder: [2.2, 1.4],
}

type Ctx = CanvasRenderingContext2D

function cell(c: Ctx, i: number, paint: (c: Ctx, rng: Rng) => void): void {
  c.save()
  c.translate((i % COLS) * CELL_W, Math.floor(i / COLS) * CELL_H)
  c.beginPath()
  c.rect(0, 0, CELL_W, CELL_H)
  c.clip()
  paint(c, new Rng(0x1a_9e + i * 977))
  c.restore()
}

/** A ribbed cactus limb from (x, y0) up to y1 (canvas y down), w wide, round-topped. */
function limb(c: Ctx, x: number, y0: number, y1: number, w: number): void {
  const g = c.createLinearGradient(x - w / 2, 0, x + w / 2, 0)
  g.addColorStop(0, '#26401f')
  g.addColorStop(0.45, '#4d6b3a')
  g.addColorStop(1, '#2a4524')
  c.fillStyle = g
  c.beginPath()
  c.moveTo(x - w / 2, y0)
  c.lineTo(x - w / 2, y1 + w / 2)
  c.arc(x, y1 + w / 2, w / 2, Math.PI, 0)
  c.lineTo(x + w / 2, y0)
  c.closePath()
  c.fill()
  // ribs
  c.strokeStyle = 'rgba(20,35,16,0.55)'
  c.lineWidth = 0.8
  for (let k = -1; k <= 1; k++) {
    c.beginPath()
    c.moveTo(x + (k * w) / 4, y0)
    c.lineTo(x + (k * w) / 4, y1 + w / 3)
    c.stroke()
  }
}

function saguaro(c: Ctx, rng: Rng, arms: number): void {
  const x = 32
  const w = 10
  limb(c, x, 128, 6, w)
  for (let a = 0; a < arms; a++) {
    const side = a % 2 === 0 ? -1 : 1
    const y = 70 - a * 9 + rng.next() * 8
    const out = 9 + rng.next() * 6
    const top = y - 24 - rng.next() * 18
    const ax = x + side * (out + w / 2)
    // the elbow
    c.fillStyle = '#3a5a2e'
    c.fillRect(Math.min(x, ax), y - 6, Math.abs(ax - x), 7)
    limb(c, ax, y + 1, top, w * 0.8)
  }
}

function joshua(c: Ctx, rng: Rng): void {
  c.strokeStyle = '#4a3e32'
  c.lineCap = 'round'
  const tips: [number, number][] = []
  const grow = (x: number, y: number, a: number, len: number, wd: number, d: number) => {
    const x1 = x + Math.cos(a) * len
    const y1 = y - Math.sin(a) * len
    c.lineWidth = wd
    c.beginPath()
    c.moveTo(x, y)
    c.lineTo(x1, y1)
    c.stroke()
    if (d <= 0) {
      tips.push([x1, y1])
      return
    }
    grow(x1, y1, a + 0.45 + rng.next() * 0.3, len * 0.75, wd * 0.72, d - 1)
    grow(x1, y1, a - 0.45 - rng.next() * 0.3, len * 0.75, wd * 0.72, d - 1)
  }
  grow(32, 128, Math.PI / 2, 46, 7, 2)
  for (const [x, y] of tips) {
    // a spiky rosette over a dead-leaf skirt
    c.fillStyle = '#7a6040'
    c.fillRect(x - 3, y, 6, 8)
    c.strokeStyle = '#56682e'
    c.lineWidth = 1.4
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x + Math.cos(a) * 8, y - Math.abs(Math.sin(a)) * 9 + 2)
      c.stroke()
    }
    c.strokeStyle = '#4a3e32'
  }
}

function ocotillo(c: Ctx, rng: Rng): void {
  c.lineCap = 'round'
  for (let k = 0; k < 13; k++) {
    const a = Math.PI / 2 + (rng.next() - 0.5) * 0.9
    const len = 85 + rng.next() * 35
    const x1 = 32 + Math.cos(a) * len
    const y1 = 128 - Math.sin(a) * len
    c.strokeStyle = '#555a3a'
    c.lineWidth = 1.8
    c.beginPath()
    c.moveTo(32, 128)
    c.quadraticCurveTo(32 + Math.cos(a) * len * 0.4, 128 - len * 0.5, x1, y1)
    c.stroke()
    c.strokeStyle = '#e04020'
    c.lineWidth = 2.6
    c.beginPath()
    c.moveTo(x1, y1 + 6)
    c.lineTo(x1, y1)
    c.stroke()
  }
}

function snag(c: Ctx, rng: Rng): void {
  c.strokeStyle = '#8a8278'
  c.lineCap = 'round'
  const grow = (x: number, y: number, a: number, len: number, wd: number, d: number) => {
    const x1 = x + Math.cos(a) * len
    const y1 = y - Math.sin(a) * len
    c.lineWidth = wd
    c.beginPath()
    c.moveTo(x, y)
    c.lineTo(x1, y1)
    c.stroke()
    if (d > 0) {
      grow(x1, y1, a + 0.5 + rng.next() * 0.4, len * 0.7, wd * 0.6, d - 1)
      if (rng.next() < 0.7) {
        grow(x1, y1, a - 0.6 - rng.next() * 0.4, len * 0.65, wd * 0.6, d - 1)
      }
    }
  }
  grow(32, 128, Math.PI / 2 + 0.1, 50, 6, 3)
}

function bush(c: Ctx, rng: Rng, base: string, tip: string, lobes: number, h: number): void {
  for (let k = 0; k < lobes; k++) {
    const x = 14 + rng.next() * 36
    const r = 12 + rng.next() * 9
    const y = 128 - r * h
    const g = c.createRadialGradient(x - r * 0.3, y - r * 0.4, 1, x, y, r)
    g.addColorStop(0, tip)
    g.addColorStop(1, base)
    c.fillStyle = g
    c.beginPath()
    c.ellipse(x, y, r, r * h, 0, 0, Math.PI * 2)
    c.fill()
  }
  // twigs breaking the outline
  c.strokeStyle = base
  c.lineWidth = 1.2
  for (let k = 0; k < 22; k++) {
    const a = rng.next() * Math.PI
    const x = 32 + (rng.next() - 0.5) * 30
    c.beginPath()
    c.moveTo(x, 118 - rng.next() * 20)
    c.lineTo(x + Math.cos(a) * 9, 100 - Math.sin(a) * 18 - rng.next() * 8)
    c.stroke()
  }
}

function boulder(c: Ctx, rng: Rng): void {
  const pts: [number, number][] = []
  for (let k = 0; k < 9; k++) {
    const a = Math.PI + (k / 8) * Math.PI
    const r = 24 + rng.next() * 7
    pts.push([32 + Math.cos(a) * r, 128 + Math.sin(a) * r * 1.2])
  }
  const g = c.createLinearGradient(0, 80, 0, 128)
  g.addColorStop(0, '#b4825c')
  g.addColorStop(1, '#6a4a38')
  c.fillStyle = g
  c.beginPath()
  c.moveTo(4, 128)
  for (const [x, y] of pts) {
    c.lineTo(x, y)
  }
  c.lineTo(60, 128)
  c.closePath()
  c.fill()
}

let atlas: CanvasTexture | null = null

/** The painted silhouette atlas (built once). */
export function impostorAtlas(): CanvasTexture | null {
  if (atlas) {
    return atlas
  }
  if (typeof document === 'undefined') {
    return null
  }
  const cv = document.createElement('canvas')
  cv.width = COLS * CELL_W
  cv.height = ROWS * CELL_H
  const c = cv.getContext('2d')
  if (!c) {
    return null
  }
  cell(c, 0, (x, r) => saguaro(x, r, 0))
  cell(c, 1, (x, r) => saguaro(x, r, 2))
  cell(c, 2, (x, r) => saguaro(x, r, 3))
  cell(c, 3, (x, r) => saguaro(x, r, 4))
  cell(c, 4, joshua)
  cell(c, 5, joshua)
  cell(c, 6, ocotillo)
  cell(c, 7, snag)
  cell(c, 8, (x, r) => bush(x, r, '#4e5a2a', '#7e8a3c', 4, 0.7))
  cell(c, 9, (x, r) => bush(x, r, '#56602c', '#8a9442', 3, 0.75))
  cell(c, 10, (x, r) => bush(x, r, '#7a8270', '#aab09a', 3, 0.65))
  cell(c, 11, (x, r) => bush(x, r, '#9a8a5a', '#e0d090', 5, 0.9))
  cell(c, 12, (x, r) => bush(x, r, '#4e6e40', '#7e9a5a', 4, 0.85))
  cell(c, 13, (x, r) => bush(x, r, '#3e5a30', '#6a8a4a', 1, 1))
  cell(c, 14, boulder)
  cell(c, 15, boulder)
  atlas = new CanvasTexture(cv)
  atlas.colorSpace = SRGBColorSpace
  atlas.anisotropy = 4
  return atlas
}

/** Card heights used to size each species' impostor from the plant's scale. */
export function impostorSize(kind: PlantKind, s: number, seed: number): [number, number] {
  const [w, h] = SIZE[kind]
  const k = 0.75 + (((seed >>> 8) % 1000) / 1000) * 0.5
  return [w * s * k, h * s * k]
}

/** Build the merged crossed-card mesh for a set of far plants (heights from `heightAt`). */
export function buildImpostors(
  plants: readonly Plant[],
  heightAt: (x: number, z: number) => number,
): Mesh | null {
  const tex = impostorAtlas()
  if (!tex || plants.length === 0) {
    return null
  }
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const tint = new Color()
  for (const p of plants) {
    const cells = CELLS[p.kind]
    if (!cells) {
      continue
    }
    const rng = new Rng(p.seed ^ 0x5f_37)
    const c = cells[Math.floor(rng.next() * cells.length)] ?? 0
    // inset 2 px so the mips never bleed a neighbour's silhouette onto the card's edge
    const iu = 2 / (COLS * CELL_W)
    const u0 = (c % COLS) / COLS + iu
    const u1 = u0 + 1 / COLS - 2 * iu
    const v1 = 1 - Math.floor(c / COLS) / ROWS
    const v0 = v1 - 1 / ROWS + 2 / (ROWS * CELL_H)
    const [w, h] = impostorSize(p.kind, p.s, p.seed)
    const y = heightAt(p.x, p.z) - 0.05
    const yaw = rng.next() * Math.PI
    tint.setScalar(0.85 + rng.next() * 0.3)
    for (const turn of [0, Math.PI / 2]) {
      const dx = (Math.cos(yaw + turn) * w) / 2
      const dz = (Math.sin(yaw + turn) * w) / 2
      const b = pos.length / 3
      pos.push(
        p.x - dx,
        y,
        p.z - dz,
        p.x + dx,
        y,
        p.z + dz,
        p.x + dx,
        y + h,
        p.z + dz,
        p.x - dx,
        y + h,
        p.z - dz,
      )
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1)
      for (let k = 0; k < 4; k++) {
        // lit from above, like the canopy it stands for (both faces shade alike)
        nor.push(0, 1, 0)
        col.push(tint.r, tint.g, tint.b)
      }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
  }
  if (idx.length === 0) {
    return null
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setAttribute('color', new Float32BufferAttribute(col, 3))
  g.setIndex(new Uint32BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  releaseAfterUpload(g)
  const m = new Mesh(g, impostorMaterial(tex))
  m.name = 'impostors'
  m.matrixAutoUpdate = false
  return m
}

let mat: MeshStandardMaterial | null = null

function impostorMaterial(tex: CanvasTexture): MeshStandardMaterial {
  if (mat) {
    return mat
  }
  mat = new MeshStandardMaterial({
    map: tex,
    vertexColors: true,
    roughness: 0.9,
    side: DoubleSide,
    alphaTest: 0.45,
    alphaToCoverage: true,
  })
  mat.name = 'impostor'
  withCloudShadow(mat)
  return mat
}
