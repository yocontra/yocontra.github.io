/** Apply the Blender-authored occiput lattice and neck skin texels to fitted bodies. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Document, Node, Primitive } from '@gltf-transform/core'
import sharp from 'sharp'
import type { Range } from './character-atlas.ts'

interface AtlasPatch {
  sha256: string
  x: number
  y: number
  image: string
}
interface HeadNape {
  reference: { head: number[]; crown: number }
  bounds: [number[], number[]]
  resolution: [number, number, number]
  offsets: number[][]
  atlas: Record<'albedo' | 'normal' | 'arm', AtlasPatch>
}
type Vec3 = [number, number, number]

const directory = resolve('tools/art/characters/head-nape')
let authored: Promise<HeadNape> | null = null
function load(): Promise<HeadNape> {
  authored ??= readFile(resolve(directory, 'lattice.json'), 'utf8').then(
    (text) => JSON.parse(text) as HeadNape,
  )
  return authored
}

function trilinear(nape: HeadNape, local: Vec3): Vec3 | null {
  const [lo, hi] = nape.bounds
  const [, ny, nz] = nape.resolution
  const cell = nape.resolution.map(
    (count, axis) =>
      (((local[axis] ?? 0) - (lo[axis] ?? 0)) / ((hi[axis] ?? 1) - (lo[axis] ?? 0))) * (count - 1),
  )
  if (cell.some((t, axis) => t < 0 || t > (nape.resolution[axis] ?? 1) - 1)) {
    return null
  }
  const base = cell.map((t, axis) => Math.min(Math.floor(t), (nape.resolution[axis] ?? 2) - 2))
  const frac = cell.map((t, axis) => t - (base[axis] ?? 0))
  const out: Vec3 = [0, 0, 0]
  for (let corner = 0; corner < 8; corner++) {
    const bits = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1]
    const weight = bits.reduce(
      (product, bit, axis) => product * (bit ? (frac[axis] ?? 0) : 1 - (frac[axis] ?? 0)),
      1,
    )
    const [i, j, k] = bits.map((bit, axis) => (base[axis] ?? 0) + bit) as Vec3
    const offset = nape.offsets[(i * ny + j) * nz + k] ?? [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      out[c] = (out[c] ?? 0) + weight * (offset[c] ?? 0)
    }
  }
  return out
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function worldPosition(node: Node): Vec3 {
  const m = node.getWorldMatrix()
  return [m[12], m[13], m[14]]
}

/** The head piece: the first skin range reaching well above the Head joint. */
function headRange(primitive: Primitive, ranges: Range[], origin: Vec3): Range | undefined {
  const position = primitive.getAttribute('POSITION')
  return ranges.find((range) => {
    if (range.slot !== 'skin' || !position) {
      return false
    }
    for (let i = range.start; i < range.start + range.count; i++) {
      if ((position.getElement(i, [])[1] ?? 0) > origin[1] + 0.1) {
        return true
      }
    }
    return false
  })
}

interface Welded {
  group: Map<number, number>
  points: Vec3[]
}

/** Vertices split by UV seams share one welded position. */
function weld(primitive: Primitive, range: Range): Welded {
  const position = primitive.getAttribute('POSITION')
  const ids = new Map<string, number>()
  const group = new Map<number, number>()
  const points: Vec3[] = []
  for (let i = range.start; i < range.start + range.count; i++) {
    const p = (position?.getElement(i, []) ?? [0, 0, 0]) as Vec3
    const key = p.map((v) => Math.round(v * 1e5)).join(',')
    const id = ids.get(key) ?? points.length
    if (id === points.length) {
      ids.set(key, id)
      points.push(p)
    }
    group.set(i, id)
  }
  return { group, points }
}

function triangles(primitive: Primitive, { group }: Welded): number[][] {
  const indices = primitive.getIndices()
  const result: number[][] = []
  for (let i = 0; i < (indices?.getCount() ?? 0); i += 3) {
    const tri = [0, 1, 2].map((k) => group.get(indices?.getScalar(i + k) ?? -1) ?? -1)
    if (tri.every((v) => v >= 0)) {
      result.push(tri)
    }
  }
  return result
}

function adjacency(faces: number[][], count: number): { near: number[][]; open: Set<number> } {
  const edges = new Map<string, number>()
  const near = Array.from({ length: count }, () => new Set<number>())
  for (const [a = 0, b = 0, c = 0] of faces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      near[u]?.add(v)
      near[v]?.add(u)
      const key = u < v ? `${u},${v}` : `${v},${u}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  const open = new Set(
    [...edges].filter(([, uses]) => uses === 1).flatMap(([key]) => key.split(',').map(Number)),
  )
  return { near: near.map((set) => [...set]), open }
}

/** Taubin smoothing removes sculpted relief without shrinking the neck. */
function taubin(points: Vec3[], near: number[][], weight: number[]): Vec3[] {
  let current = points.map((p) => [...p] as Vec3)
  for (let pass = 0; pass < 24; pass++) {
    const factor = pass % 2 === 0 ? 0.5 : -0.53
    const previous = current
    current = previous.map((p, id) => {
      const ring = near[id] ?? []
      const w = (weight[id] ?? 0) * factor
      if (w === 0 || ring.length === 0) {
        return p
      }
      return p.map(
        (v, k) =>
          v + w * (ring.reduce((sum, n) => sum + (previous[n]?.[k] ?? 0), 0) / ring.length - v),
      ) as Vec3
    })
  }
  return current
}

function cross(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const f = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const [ex = 0, ey = 0, ez = 0] = e
  const [fx = 0, fy = 0, fz = 0] = f
  return [ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx]
}

/**
 * Relax the sculpted Superhero neck muscles behind and beside the throat. Vertices split by
 * UV seams move together; the open collar edge stays put.
 */
function relaxNeck(primitive: Primitive, range: Range, origin: Vec3, scale: number): void {
  const position = primitive.getAttribute('POSITION')
  const normal = primitive.getAttribute('NORMAL')
  if (!(position && normal)) {
    return
  }
  const welded = weld(primitive, range)
  const faces = triangles(primitive, welded)
  const { near, open } = adjacency(faces, welded.points.length)
  const weight = welded.points.map((p, id) => {
    const y = (p[1] - origin[1]) / scale
    const z = (p[2] - origin[2]) / scale
    const height = smoothstep(-0.085, -0.06, y) * (1 - smoothstep(0.0, 0.035, y))
    return open.has(id) ? 0 : height * smoothstep(0.045, 0.0, z)
  })
  const relaxed = taubin(welded.points, near, weight)
  const sums = relaxed.map((): Vec3 => [0, 0, 0])
  for (const face of faces) {
    const [a = 0, b = 0, c = 0] = face
    const n = cross(relaxed[a] ?? [0, 0, 0], relaxed[b] ?? [0, 0, 0], relaxed[c] ?? [0, 0, 0])
    for (const v of face) {
      sums[v] = (sums[v] ?? [0, 0, 0]).map((value, k) => value + (n[k] ?? 0)) as Vec3
    }
  }
  for (const [index, id] of welded.group) {
    const w = weight[id] ?? 0
    if (w > 0) {
      position.setElement(index, relaxed[id] ?? [0, 0, 0])
      const original = normal.getElement(index, [])
      const sum = sums[id] ?? [0, 0, 1]
      const length = Math.hypot(...sum) || 1
      const mixed = sum.map((v, k) => (original[k] ?? 0) * (1 - w) + (v / length) * w)
      const norm = Math.hypot(...mixed) || 1
      normal.setElement(index, [...mixed.map((v) => v / norm), ...original.slice(3)])
    }
  }
}

/** The short crop hugs the skull within a millimetre; keep it clear of the rounder occiput. */
/** World height of the authored hat's crown opening behind the head, if the head wears one. */
function hatRim(head: Node, origin: Vec3): number | null {
  let rim: number | null = null
  head.traverse((node) => {
    const position = node.getSkin()
      ? null
      : node.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')
    if (!position) {
      return
    }
    const m = node.getWorldMatrix()
    for (let i = 0; i < position.getCount(); i++) {
      const [x = 0, y = 0, z = 0] = position.getElement(i, [])
      const world = [0, 1, 2].map(
        (k) => (m[k] ?? 0) * x + (m[4 + k] ?? 0) * y + (m[8 + k] ?? 0) * z + (m[12 + k] ?? 0),
      )
      const dx = (world[0] ?? 0) - origin[0]
      const dz = (world[2] ?? 0) - origin[2]
      if (dz < -0.03 && Math.hypot(dx, dz) < 0.12) {
        rim = Math.min(rim ?? Number.POSITIVE_INFINITY, world[1] ?? 0)
      }
    }
  })
  return rim
}

function liftHair(
  primitive: Primitive,
  ranges: Range[],
  { origin, scale, under }: { origin: Vec3; scale: number; under: (y: number) => number },
): void {
  const position = primitive.getAttribute('POSITION')
  const normal = primitive.getAttribute('NORMAL')
  if (!(position && normal)) {
    return
  }
  for (const range of ranges.filter((candidate) => candidate.name === 'Hair')) {
    for (let i = range.start; i < range.start + range.count; i++) {
      const p = position.getElement(i, [])
      const n = normal.getElement(i, [])
      const behind = smoothstep(0.02, -0.03, ((p[2] ?? 0) - origin[2]) / scale)
      const lift = 0.0025 * scale * behind * under(p[1] ?? 0)
      position.setElement(
        i,
        p.map((v, k) => v + (n[k] ?? 0) * lift),
      )
    }
  }
}

/** Normals follow the lattice's deformation gradient F = I + J, as cof(F) n. */
function deformedNormal(
  field: (p: Vec3) => Vec3 | null,
  p: Vec3,
  n: number[],
  h: number,
): number[] {
  const jacobian = [0, 1, 2].map((axis) => {
    const plus = [...p] as Vec3
    const minus = [...p] as Vec3
    plus[axis] = (plus[axis] ?? 0) + h
    minus[axis] = (minus[axis] ?? 0) - h
    const a = field(plus) ?? [0, 0, 0]
    const b = field(minus) ?? [0, 0, 0]
    return a.map((v, c) => (v - (b[c] ?? 0)) / (2 * h))
  })
  const f = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? 1 : 0) + (jacobian[c]?.[r] ?? 0)))
  const at = (r: number, c: number): number => f[(r + 3) % 3]?.[(c + 3) % 3] ?? 0
  const cofactor = (r: number, c: number): number =>
    at(r + 1, c + 1) * at(r + 2, c + 2) - at(r + 1, c + 2) * at(r + 2, c + 1)
  const out = [0, 1, 2].map((r) =>
    [0, 1, 2].reduce((sum, c) => sum + cofactor(r, c) * (n[c] ?? 0), 0),
  )
  const length = Math.hypot(...out) || 1
  return [...out.map((v) => v / length), ...n.slice(3)]
}

function applyLattice(primitive: Primitive, field: (p: Vec3) => Vec3 | null, h: number): boolean {
  const position = primitive.getAttribute('POSITION')
  const normal = primitive.getAttribute('NORMAL')
  let changed = false
  for (let index = 0; index < (position?.getCount() ?? 0); index++) {
    const p = position?.getElement(index, [0, 0, 0]) as Vec3
    const offset = field(p)
    if (!offset || offset.every((v) => Math.abs(v) < 1e-7)) {
      continue
    }
    position?.setElement(
      index,
      p.map((v, k) => v + (offset[k] ?? 0)),
    )
    if (normal) {
      normal.setElement(index, deformedNormal(field, p, normal.getElement(index, []), h))
    }
    changed = true
  }
  return changed
}

/** Deform the fitted body's bind-pose head region; skinning and weights are unchanged. */
export async function repairHeadNape(doc: Document): Promise<boolean> {
  const nape = await load()
  let changed = false
  for (const node of doc.getRoot().listNodes()) {
    const head = node
      .getSkin()
      ?.listJoints()
      .find((joint) => joint.getName() === 'Head')
    const mesh = node.getMesh()
    if (!(head && mesh && node.getName() === 'Character')) {
      continue
    }
    const origin = worldPosition(head)
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')
      const ranges = (primitive.getExtras().pieceRanges ??
        node.getExtras().pieceRanges ??
        []) as Range[]
      const skull = headRange(primitive, ranges, origin)
      if (!(position && skull)) {
        continue
      }
      let crown = 0
      for (let i = skull.start; i < skull.start + skull.count; i++) {
        crown = Math.max(crown, (position.getElement(i, [])[1] ?? 0) - origin[1])
      }
      const scale = crown / nape.reference.crown
      // The rigid hat does not follow the reshaped skull: stay inside its crown.
      const rim = hatRim(head, origin)
      const under = (y: number): number =>
        rim === null ? 1 : 1 - smoothstep(rim - 0.03, rim - 0.005, y)
      relaxNeck(primitive, skull, origin, scale)
      liftHair(primitive, ranges, { origin, scale, under })
      const field = (p: Vec3): Vec3 | null =>
        trilinear(nape, p.map((v, k) => (v - (origin[k] ?? 0)) / scale) as Vec3)?.map(
          (v) => v * scale * under(p[1]),
        ) as Vec3 | null
      changed = applyLattice(primitive, field, 0.002 * scale) || changed
    }
  }
  return changed
}

function composite(
  image: { data: Buffer; width: number },
  overlay: { data: Buffer; width: number; height: number },
  patch: AtlasPatch,
): void {
  for (let i = 0; i < overlay.width * overlay.height; i++) {
    const alpha = (overlay.data[i * 4 + 3] ?? 0) / 255
    const x = i % overlay.width
    const y = Math.floor(i / overlay.width)
    const target = ((patch.y + y) * image.width + patch.x + x) * 4
    for (let c = 0; c < 3 && alpha > 0; c++) {
      image.data[target + c] = Math.round(
        (overlay.data[i * 4 + c] ?? 0) * alpha + (image.data[target + c] ?? 0) * (1 - alpha),
      )
    }
  }
}

/** Replace the shared skin atlas's neck-island texels with the authored skin. */
export async function patchSkinAtlas(
  bytes: Uint8Array,
  image: { data: Buffer; width: number; height: number },
): Promise<void> {
  const nape = await load()
  const sha = createHash('sha256').update(bytes).digest('hex')
  for (const patch of Object.values(nape.atlas).filter((entry) => entry.sha256 === sha)) {
    const { data, info } = await sharp(resolve(directory, patch.image))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    composite(image, { data, width: info.width, height: info.height }, patch)
  }
}
