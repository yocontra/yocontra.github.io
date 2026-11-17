/** Apply the Blender-authored neck taper and skin texels to fitted bodies. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Document, Node, Primitive } from '@gltf-transform/core'
import { calculateNormals, Vec3 as NativeVec3 } from 'playcanvas'
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

/** Rebuild the actual deformed surface, sharing normals only across physical UV seams. */
function refreshNeckNormals(primitive: Primitive, range: Range, origin: Vec3, scale: number): void {
  const position = primitive.getAttribute('POSITION')
  const normal = primitive.getAttribute('NORMAL')
  const indices = primitive.getIndices()
  if (!(position && normal && indices)) {
    throw new Error('Head repair requires indexed skin normals')
  }
  const unique = new Map<string, number>()
  const remap = new Map<number, number>()
  const points: number[] = []
  for (let i = range.start; i < range.start + range.count; i++) {
    const point = position.getElement(i, [])
    const key = point.join(',')
    let vertex = unique.get(key)
    if (vertex === undefined) {
      vertex = unique.size
      unique.set(key, vertex)
      points.push(...point)
    }
    remap.set(i, vertex)
  }
  const triangles: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const face = [0, 1, 2].map((corner) => remap.get(indices.getScalar(i + corner)))
    if (face.every((vertex) => vertex !== undefined)) {
      triangles.push(...(face as number[]))
    }
  }
  const geometric = calculateNormals(points, triangles)
  for (const [i, vertex] of remap) {
    const [x = 0, y = 0, z = 0] = position
      .getElement(i, [])
      .map((v, k) => (v - (origin[k] ?? 0)) / scale)
    const weight =
      smoothstep(-0.06, -0.04, y) *
      (1 - smoothstep(0.055, 0.085, y)) *
      smoothstep(-0.005, -0.025, z) *
      (1 - smoothstep(0.06, 0.075, Math.abs(x)))
    if (weight === 0) {
      continue
    }
    const previous = normal.getElement(i, [])
    const target = geometric.slice(vertex * 3, vertex * 3 + 3)
    const n = new NativeVec3()
      .lerp(
        new NativeVec3(previous[0], previous[1], previous[2]),
        new NativeVec3(target[0], target[1], target[2]),
        weight,
      )
      .normalize()
    normal.setElement(i, [n.x, n.y, n.z])
  }
}

function applyLattice(
  primitive: Primitive,
  range: Range,
  field: (p: Vec3) => Vec3 | null,
): boolean {
  const position = primitive.getAttribute('POSITION')
  let changed = false
  for (let index = range.start; index < range.start + range.count; index++) {
    const p = position?.getElement(index, [0, 0, 0]) as Vec3
    const offset = field(p)
    if (!offset || offset.every((v) => Math.abs(v) < 1e-7)) {
      continue
    }
    position?.setElement(
      index,
      p.map((v, k) => v + (offset[k] ?? 0)),
    )
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
      const field = (p: Vec3): Vec3 | null =>
        trilinear(nape, p.map((v, k) => (v - (origin[k] ?? 0)) / scale) as Vec3)?.map(
          (v) => v * scale * under(p[1]),
        ) as Vec3 | null
      const deformed = applyLattice(primitive, skull, field)
      if (deformed) {
        refreshNeckNormals(primitive, skull, origin, scale)
      }
      changed = deformed || changed
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
