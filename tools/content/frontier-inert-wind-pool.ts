/** Pack the native map with shared wind buffers and its existing external freight texture. */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Document } from '@gltf-transform/core'
import { compressedCharacterTexture } from './character-textures.ts'
import { withContentOutput } from './content-output.ts'

const FREIGHT_URI = /^\.\.\/environments\/textures\/[a-f0-9]{24}\.color\.ktx2$/u

/** Match the standalone atlas used by the renderer to the source that produced it. */
export async function packFrontierMap(path: string, cache: string) {
  const albedo = await readFile('tools/art/environments/freight-crates/freight-albedo.png')
  const atlas = await withContentOutput(cache, () =>
    compressedCharacterTexture(albedo, true, 'environments'),
  )
  return poolFrontierInertWindViews(path, join(cache, 'environments', 'textures', basename(atlas)))
}

export function freightAtlasFiles(native: Document, directory: string) {
  const atlas = native
    .getRoot()
    .listTextures()
    .find((texture) => texture.getName() === 'Freight albedo')
  const uri = atlas?.getURI()
  if (!uri) {
    return []
  }
  if (!FREIGHT_URI.test(uri)) {
    throw new Error('Unexpected external freight atlas path')
  }
  return [
    [
      join(directory, 'baked', uri),
      join('public/experiments/out-west/3d/native-v2/baked', uri),
    ] as const,
  ]
}

interface BufferView {
  buffer: number
  byteLength: number
  byteOffset?: number
  byteStride?: number
  extensions?: unknown
}

interface FrontierGlb {
  accessors: {
    bufferView?: number
    byteOffset?: number
    componentType: number
    count: number
    type: string
  }[]
  buffers: { byteLength: number; uri?: string }[]
  bufferViews: BufferView[]
  images?: { name?: string; bufferView?: number | undefined; uri?: string }[]
  meshes: {
    primitives: {
      extras?: { outWestInertWind?: number }
      targets?: Record<string, number>[]
    }[]
  }[]
}

const GLB = 0x46_54_6c_67
const JSON_CHUNK = 0x4e_4f_53_4a
const BIN_CHUNK = 0x00_4e_49_42
const pad = (bytes: number) => (4 - (bytes % 4)) % 4

function visitViews(value: unknown, visit: (index: number, owner: object) => void) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      visitViews(entry, visit)
    }
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'bufferView' && typeof entry === 'number') {
        visit(entry, value)
      } else if (key !== 'bufferViews') {
        visitViews(entry, visit)
      }
    }
  }
}

function eligibleViews(document: FrontierGlb) {
  const uses = new Map<number, number>()
  visitViews(document, (index) => {
    uses.set(index, (uses.get(index) ?? 0) + 1)
  })
  const pooled = new Set<number>()
  for (const { primitives } of document.meshes) {
    for (const primitive of primitives) {
      if (primitive.extras?.outWestInertWind !== 1) {
        continue
      }
      for (const target of primitive.targets ?? []) {
        const a = document.accessors[target.POSITION ?? -1]
        if (a?.bufferView === undefined || uses.get(a.bufferView) !== 1) {
          continue
        }
        const v = document.bufferViews[a.bufferView]
        if (
          v &&
          a.type === 'VEC3' &&
          a.componentType === 5126 &&
          (a.byteOffset ?? 0) === 0 &&
          v.byteLength === a.count * 12 &&
          (v.byteStride ?? 12) === 12 &&
          v.extensions === undefined
        ) {
          pooled.add(a.bufferView)
        }
      }
    }
  }
  return pooled
}

async function linkFreightTexture(
  document: FrontierGlb,
  payloads: Buffer[],
  path: string,
  freightTexture?: string,
) {
  // The freight atlas already ships as an immutable KTX2. Reference those same
  // bytes from the native material, keeping the map below the single-file limit.
  const image = document.images?.find((entry) => entry.name === 'Freight albedo')
  const external = freightTexture ? image?.bufferView : undefined
  if (freightTexture && image && external !== undefined) {
    const data = payloads[external]
    if (!data?.equals(await readFile(freightTexture))) {
      throw new Error('Freight KTX2 does not match the embedded atlas')
    }
    image.uri = `../environments/textures/${basename(freightTexture)}`
    const target = join(dirname(path), image.uri)
    await mkdir(dirname(target), { recursive: true })
    if (resolve(target) !== resolve(freightTexture)) {
      await writeFile(target, data)
    }
    image.bufferView = undefined
    visitViews(document, (index, owner) => {
      if (index === external) {
        throw new Error('Freight atlas bufferView has another owner')
      }
      if (index > external) {
        Object.assign(owner, { bufferView: index - 1 })
      }
    })
  }
  return external
}

/** Final native-only repack. Keep each zero bufferView length and accessor count for older loaders. */
export async function poolFrontierInertWindViews(path: string, freightTexture?: string) {
  const source = await readFile(path)
  if (
    source.length < 28 ||
    source.readUInt32LE(0) !== GLB ||
    source.readUInt32LE(4) !== 2 ||
    source.readUInt32LE(8) !== source.length ||
    source.readUInt32LE(16) !== JSON_CHUNK
  ) {
    throw new Error('Expected a GLB 2 Frontier container')
  }
  const jsonEnd = 20 + source.readUInt32LE(12)
  if (
    jsonEnd + 8 > source.length ||
    source.readUInt32LE(jsonEnd + 4) !== BIN_CHUNK ||
    source.readUInt32LE(jsonEnd) !== source.length - jsonEnd - 8
  ) {
    throw new Error('Expected one binary Frontier buffer')
  }
  const document = JSON.parse(source.toString('utf8', 20, jsonEnd)) as FrontierGlb
  const base = source.subarray(jsonEnd + 8)
  const [buffer] = document.buffers
  if (document.buffers.length !== 1 || !buffer || buffer.uri !== undefined) {
    throw new Error('Expected one embedded Frontier buffer')
  }
  if (document.bufferViews.some((view) => view.extensions !== undefined)) {
    throw new Error('Cannot repack Frontier views with extension-owned binary offsets')
  }
  const views = eligibleViews(document)
  if (views.size < 2 && !freightTexture) {
    return { views: 0, bytesSaved: 0 }
  }

  const payloads = document.bufferViews.map((v) => {
    const from = v.byteOffset ?? 0
    if (v.buffer !== 0 || from < 0 || v.byteLength <= 0 || from + v.byteLength > base.length) {
      throw new Error('Invalid Frontier binary bufferView')
    }
    return base.subarray(from, from + v.byteLength)
  })
  let zeroBytes = 0
  for (const id of views) {
    const data = payloads[id]
    if (!data || data.some((byte) => byte !== 0)) {
      throw new Error('Marked Frontier inert wind data is nonzero')
    }
    zeroBytes = Math.max(zeroBytes, data.length)
  }
  const external = await linkFreightTexture(document, payloads, path, freightTexture)
  const chunks = [Buffer.alloc(zeroBytes)]
  let cursor = zeroBytes
  for (const [i, v] of document.bufferViews.entries()) {
    if (i === external) {
      continue
    }
    if (views.has(i)) {
      v.byteOffset = 0
      continue
    }
    const data = payloads[i]
    if (!data) {
      throw new Error('Missing Frontier buffer payload')
    }
    v.byteOffset = cursor
    const padding = pad(data.length)
    chunks.push(data, Buffer.alloc(padding))
    cursor += data.length + padding
  }

  if (external !== undefined) {
    document.bufferViews.splice(external, 1)
  }
  buffer.byteLength = cursor
  const json = Buffer.from(JSON.stringify(document))
  const jsonPadding = Buffer.alloc(pad(json.length), 0x20)
  const header = Buffer.alloc(20)
  const binHeader = Buffer.alloc(8)
  header.writeUInt32LE(GLB, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + json.length + jsonPadding.length + cursor, 8)
  header.writeUInt32LE(json.length + jsonPadding.length, 12)
  header.writeUInt32LE(JSON_CHUNK, 16)
  binHeader.writeUInt32LE(cursor, 0)
  binHeader.writeUInt32LE(BIN_CHUNK, 4)
  const result = Buffer.concat([header, json, jsonPadding, binHeader, ...chunks])
  const directory = await mkdtemp(join(dirname(path), '.frontier-pool-'))
  try {
    const output = join(directory, 'frontier.glb')
    await writeFile(output, result)
    await rename(output, path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  return { views: views.size, bytesSaved: source.length - result.length }
}
