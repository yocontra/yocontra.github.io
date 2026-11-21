/** Fit the Blender foreparts while retaining the original animated grip and sight mounts. */
import { type Accessor, type Material, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  compactPrimitive,
  copyToDocument,
  dedup,
  joinPrimitives,
  prune,
  unpartition,
  weld,
} from '@gltf-transform/functions'
import sharp from 'sharp'
import { compressedCharacterTexture } from './character-textures.ts'
import { contentOutput } from './content-output.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const cropped = { left: 24, top: 115, width: 416, height: 26 }
const width = 512
const rows = 64
const planks = 'public/experiments/out-west/3d/tex/planks_'
const detail = 'tools/art/characters/textures/worn-metal-'
const wood = await sharp(`${planks}diff.webp`)
  .extract(cropped)
  .resize(width, rows, { fit: 'fill' })
  .linear([1.19, 1.03, 0.88], [0, 0, 0])
  .removeAlpha()
  .png()
  .toBuffer()
const woodNormal = await sharp(`${planks}nor.webp`)
  .extract(cropped)
  .resize(width, rows, { fit: 'fill' })
  .removeAlpha()
  .png()
  .toBuffer()
const metalNormal = await sharp(`${detail}normal.png`)
  .resize(width, rows, { fit: 'fill' })
  .removeAlpha()
  .png()
  .toBuffer()
const metalPaint = await sharp(`${detail}color.png`)
  .resize(width, rows, { fit: 'fill' })
  .removeAlpha()
  .greyscale()
  .raw()
  .toBuffer()

function colorBand(material: Material) {
  const [r, g, b] = material.getBaseColorFactor()
  const srgb = (v: number) => v ** (1 / 2.2) * 255
  const values = [srgb(r), srgb(g), srgb(b)]
  const data = Buffer.alloc(width * rows * 3)
  for (let i = 0; i < width * rows; i++) {
    const wear = (metalPaint[i] ?? 128) / 255
    const scale = 0.65 + 0.54 * wear
    for (let j = 0; j < 3; j++) {
      data[i * 3 + j] = Math.min(255, Math.round((values[j] ?? 90) * scale))
    }
  }
  return sharp(data, { raw: { width, height: rows, channels: 3 } })
    .png()
    .toBuffer()
}

async function nativeAtlas(materials: Material[]) {
  const height = materials.length * rows
  const color = await Promise.all(
    materials.map((m) => (m.getName().includes('walnut') ? wood : colorBand(m))),
  )
  const normal = materials.map((m) => (m.getName().includes('walnut') ? woodNormal : metalNormal))
  const arm = await Promise.all(
    materials.map((m) =>
      sharp({
        create: {
          width,
          height: rows,
          channels: 3,
          background: {
            r: 255,
            g: Math.round(m.getRoughnessFactor() * 255),
            b: Math.round(m.getMetallicFactor() * 255),
          },
        },
      })
        .png()
        .toBuffer(),
    ),
  )
  const pack = (images: Buffer[]) =>
    sharp({ create: { width, height, channels: 3, background: '#808080' } })
      .composite(images.map((input, i) => ({ input, left: 0, top: i * rows })))
      .png()
      .toBuffer()
  const [a, n, r] = await Promise.all([pack(color), pack(normal), pack(arm)])
  const [albedo, normalMap, armMap] = await Promise.all([
    compressedCharacterTexture(a, true, 'characters', 'etc1s'),
    compressedCharacterTexture(n, false),
    compressedCharacterTexture(r, false),
  ])
  return { albedo, normal: normalMap, arm: armMap, normalScale: 0.47, width, height }
}

type Kind = 'rifle' | 'shotgun'
interface Piece {
  faces: number[]
  low: number
  high: number
}

function components(position: Accessor, indices: Uint16Array | Uint32Array | Uint8Array): Piece[] {
  const parent = Array.from({ length: position.getCount() }, (_, i) => i)
  const find = (i: number): number => {
    const current = parent[i] ?? i
    if (current === i) {
      return i
    }
    const root = find(current)
    parent[i] = root
    return root
  }
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }
  const shared = new Map<string, number>()
  const points = parent.map((_, i) => position.getElement(i, []))
  for (const [i, point] of points.entries()) {
    const key = point.map((value) => Math.round(value * 100_000)).join(',')
    const first = shared.get(key)
    if (first === undefined) {
      shared.set(key, i)
    } else {
      join(i, first)
    }
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] ?? 0
    join(a, indices[i + 1] ?? 0)
    join(a, indices[i + 2] ?? 0)
  }
  const pieces = new Map<number, Piece>()
  for (let i = 0; i < indices.length; i += 3) {
    const indicesOfFace = indices.subarray(i, i + 3)
    const group = find(indicesOfFace[0] ?? 0)
    const piece = pieces.get(group) ?? {
      faces: [],
      low: Number.POSITIVE_INFINITY,
      high: Number.NEGATIVE_INFINITY,
    }
    for (const index of indicesOfFace) {
      const x = points[index]?.[0] ?? 0
      piece.low = Math.min(piece.low, x)
      piece.high = Math.max(piece.high, x)
    }
    piece.faces.push(i / 3)
    pieces.set(group, piece)
  }
  return [...pieces.values()]
}

function hideFormerForeparts(primitive: Primitive, kind: Kind): void {
  const vertex = primitive.getAttribute('POSITION')
  const index = primitive.getIndices()
  const values = index?.getArray()
  if (
    !(
      vertex &&
      index &&
      (values instanceof Uint8Array ||
        values instanceof Uint16Array ||
        values instanceof Uint32Array)
    )
  ) {
    throw new Error('Missing the authored held asset contact surfaces')
  }
  const removed = new Set<number>()
  const close = (a: number, b: number) => Math.abs(a - b) < 0.0005
  for (const part of components(vertex, values)) {
    const count = part.faces.length
    const matched =
      kind === 'rifle'
        ? (count === 144 && close(part.high, 0.998)) || (count === 192 && close(part.low, -0.025))
        : (count === 72 && close(part.high, 0.998)) || (count === 168 && close(part.low, 0.009))
    if (matched) {
      for (const face of part.faces) {
        removed.add(face)
      }
    }
  }
  if (removed.size !== (kind === 'rifle' ? 336 : 312)) {
    throw new Error(`The held ${kind} source grip boundaries changed`)
  }
  index.setArray(Uint16Array.from(values.filter((_, i) => !removed.has(Math.floor(i / 3)))))
  compactPrimitive(primitive)
}

async function fitHeldWeapon(kind: Kind): Promise<void> {
  const art = await io.read(`tools/art/characters/held-surfaces/${kind}.glb`)
  const parts = art
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
  const rawMaterials = art.getRoot().listMaterials()
  const finish = await nativeAtlas(rawMaterials)
  const path = contentOutput('dynamic', `held-${kind}.glb`)
  const doc = await io.read(path)
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === kind && n.getMesh())
  const old = node?.getMesh()
  if (!(node && old) || old.listPrimitives().length !== 1) {
    throw new Error('Bake the native held weapon before fitting its new surface')
  }
  const coat = doc
    .createMaterial('Gun')
    .setMetallicFactor(1)
    .setRoughnessFactor(1)
    .setExtras({ nativePbr: finish })
  const copied = copyToDocument(doc, art, parts)
  const pieces = parts.map((source) => {
    const p = copied.get(source) as Primitive
    const material = source.getMaterial()
    const band = material ? rawMaterials.indexOf(material) : -1
    const uv = p.getAttribute('TEXCOORD_0')
    if (!uv || band < 0) {
      throw new Error('Missing authored UVs')
    }
    for (let i = 0; i < uv.getCount(); i++) {
      const [u = 0, v = 0] = uv.getElement(i, [])
      uv.setElement(i, [u, (band * rows + 3 + v * (rows - 6)) / finish.height])
    }
    return p.setMaterial(coat)
  })
  const legacy = old.listPrimitives()[0]
  if (!legacy) {
    throw new Error('Missing native grip geometry')
  }
  hideFormerForeparts(legacy, kind)
  const mesh = doc.createMesh(kind).addPrimitive(joinPrimitives(pieces)).addPrimitive(legacy)
  for (const p of pieces) {
    p.dispose()
  }
  node.setMesh(mesh)
  old.removePrimitive(legacy)
  old.dispose()
  await doc.transform(
    dedup(),
    weld(),
    prune({ keepAttributes: true, keepLeaves: true }),
    unpartition(),
  )
  await io.write(path, doc)
  console.log(`Fitted the held ${kind} fore-end and barrel`)
}

for (const kind of ['rifle', 'shotgun'] as const) {
  await fitHeldWeapon(kind)
}
