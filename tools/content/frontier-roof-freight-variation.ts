/** Native surface finish pass for the walkable cedar roofs and tall central freight cases. */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { type Document, type Node, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions'
import sharp from 'sharp'
import { compressedCharacterTexture } from './character-textures.ts'
import { contentOutput, withContentOutput } from './content-output.ts'
import type { FreightPiece } from './freight-crates-geometry.ts'
import type { FreightPrefabManifest } from './freight-crates-install.ts'
import { packFrontierMap } from './frontier-inert-wind-pool.ts'
import { SHAKE_TILE } from './frontier-roof-material.ts'

const VERSION = 'perditionCedarAndFreight'
const SIZE = 1536
const GRID = 4
const ROWS = SHAKE_TILE.courses * GRID
const SHAKES = 9 * GRID
const COVER_IDS = [177, 178, 227]
const WOOD = 'public/experiments/out-west/3d/tex/vplanks_diff.webp'
const FREIGHT = 'tools/art/environments/freight-crates/profiles.json'
const PLANK = /(?:plank|lid-panel|floor)-\d+/u

function random(a: number, b: number): number {
  let hash = Math.imul(a + 819, 0x4_5d_9f_3b) ^ Math.imul(b + 137, 0x11_9d_e1_f3)
  hash = Math.imul(hash ^ (hash >>> 16), 0x4_5d_9f_3b)
  return ((hash ^ (hash >>> 16)) >>> 0) / 0xff_ff_ff_ff
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clampByte(value: number): number {
  return Math.round(Math.max(0, Math.min(255, value)))
}

/** Each course has its own widths and starting point without a repeated eight-course pattern. */
function shakeCourse(row: number) {
  const widths = Array.from({ length: SHAKES }, (_, i) => 0.67 + 0.84 * random(i, row))
  const span = widths.reduce((sum, width) => sum + width, 0)
  let edge = 0
  const cumulative = widths.map((width) => {
    const start = edge
    edge += width / span
    return { start, edge }
  })
  const phase = random(row, 947) * 0.4
  return Array.from({ length: SIZE }, (_, x) => {
    const u = (x / SIZE + phase) % 1
    const i = cumulative.findIndex((part) => u < part.edge)
    const board = cumulative[i]
    if (!board) {
      throw new Error(`Cedar course ${row} has an uncovered pixel`)
    }
    const width = board.edge - board.start
    const local = (u - board.start) / width
    return { i, local, joint: Math.min(local, 1 - local) * width * SIZE }
  })
}

function cedarNormal(relief: Float32Array): Buffer {
  const pixels = Buffer.alloc(SIZE * SIZE * 3)
  const at = (u: number, v: number) => relief[((v + SIZE) % SIZE) * SIZE + ((u + SIZE) % SIZE)] ?? 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) / ((2 * SHAKE_TILE.along * GRID) / SIZE)
      const ny = (at(x, y + 1) - at(x, y - 1)) / ((2 * SHAKE_TILE.slope * GRID) / SIZE)
      const length = Math.hypot(nx, ny, 1)
      const address = (y * SIZE + x) * 3
      pixels[address] = clampByte(127.5 * (1 + nx / length))
      pixels[address + 1] = clampByte(127.5 * (1 + ny / length))
      pixels[address + 2] = clampByte(127.5 * (1 + 1 / length))
    }
  }
  return pixels
}

async function cedarMaps(): Promise<[Buffer, Buffer]> {
  const source = await sharp(WOOD).resize(512, 512).removeAlpha().raw().toBuffer()
  const paint = Buffer.alloc(SIZE * SIZE * 3)
  const relief = new Float32Array(SIZE * SIZE)
  for (let row = 0; row < ROWS; row++) {
    const course = shakeCourse(row)
    const depth = SIZE / ROWS
    for (let y = row * depth; y < (row + 1) * depth; y++) {
      const rise = 1 - (y % depth) / depth
      for (const [x, { i, local, joint }] of course.entries()) {
        const donorSeed = i + row * SHAKES
        const grainX = Math.floor(512 * (0.36 + 0.31 * random(donorSeed, 531) + 0.063 * local))
        const grainY = Math.floor(512 * ((random(donorSeed, 191) + rise * 0.2) % 1))
        const donor = (grainY * 512 + grainX) * 3
        const pixel = y * SIZE + x
        const butt = 0.03 * (random(donorSeed, 33) - 0.5)
        const exposed = smooth((rise + butt) * 18)
        const jointShadow = mix(0.68, 1, smooth(joint / 2.1))
        const sun = 1.18 + 0.27 * random(donorSeed, 169)
        const exposure = (0.79 + 0.21 * exposed) * jointShadow * sun
        for (let channel = 0; channel < 3; channel++) {
          paint[pixel * 3 + channel] = clampByte((source[donor + channel] ?? 0) * exposure)
        }
        const grain = (source[donor + 1] ?? 0) * 0.000_012
        relief[pixel] = 0.012 * exposed * (1 - rise * 0.66) * smooth(joint / 2.2) + grain
      }
    }
  }
  const png = (pixels: Buffer) =>
    sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 3 } })
      .png()
      .toBuffer()
  return Promise.all([png(paint), png(cedarNormal(relief))])
}

function field(x: number, z: number): number {
  const i = Math.floor(x)
  const j = Math.floor(z)
  const u = smooth(x - i)
  const v = smooth(z - j)
  return mix(
    mix(random(i, j), random(i + 1, j), u),
    mix(random(i, j + 1), random(i + 1, j + 1), u),
    v,
  )
}

function varyRoofUvAndColor(primitive: Primitive): number {
  const uv = primitive.getAttribute('TEXCOORD_0')
  const position = primitive.getAttribute('POSITION')
  const color = primitive.getAttribute('COLOR_0')
  const values = uv?.getArray()
  if (!(uv && position && color && values instanceof Float32Array)) {
    throw new Error('Missing cedar shake UVs, tint or positions')
  }
  // The material repeat grows 4× in each direction. Keep the original physical course pitch.
  uv.setArray(Float32Array.from(values, (value) => value / GRID))
  const p: number[] = []
  const c: number[] = []
  for (let index = 0; index < position.getCount(); index++) {
    const [x = 0, y = 0, z = 0] = position.getElement(index, p)
    const broad = field((x + y * 0.8) / 2.9, (z - y * 0.3) / 3.8)
    const streak = field(x * 0.7 + z * 0.15, z * 0.22 + x * 0.15)
    const tint = 0.85 + broad * 0.27 + streak * 0.075
    color.getElement(index, c)
    for (let channel = 0; channel < 3; channel++) {
      c[channel] = Math.min(1, (c[channel] ?? 1) * tint)
    }
    color.setElement(index, c)
  }
  return position.getCount()
}

async function installCedar(doc: Document): Promise<number> {
  const materials = doc.getRoot().listMaterials()
  const material = materials.find((entry) => entry.getName() === 'Perdition weathered cedar shakes')
  const parts = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives().filter((part) => part.getMaterial() === material))
  const oldDiffuse = material?.getBaseColorTexture()
  const oldNormal = material?.getNormalTexture()
  if (!(material && parts.length === 1 && parts[0] && oldDiffuse && oldNormal)) {
    throw new Error('Missing the native cedar shake surface')
  }
  const [albedo, normal] = await cedarMaps()
  const add = async (name: string, bytes: Buffer, color: boolean) => {
    const url = await compressedCharacterTexture(
      bytes,
      color,
      'environments',
      color ? 'etc1s' : 'uastc',
    )
    const encoded = await readFile(contentOutput('environments', 'textures', basename(url)))
    return doc.createTexture(name).setMimeType('image/ktx2').setImage(encoded)
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  material.setBaseColorTexture(await add('Perdition long-course cedar albedo', albedo, true))
  material.setNormalTexture(await add('Perdition long-course cedar bevel', normal, false))
  for (const texture of [oldDiffuse, oldNormal]) {
    if (texture.listParents().every((parent) => parent.propertyType === 'Root')) {
      texture.dispose()
    }
  }
  return varyRoofUvAndColor(parts[0])
}

function pieceTone(name: string, seed: number) {
  const code = [...name].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0), 17)
  const isPlank = PLANK.test(name)
  const shade = isPlank ? 0.62 + random(code, seed) * 0.54 : 0.85 + random(code, seed) * 0.19
  const washed = random(seed, 411)
  const warm = random(code, seed + 12)
  const red = shade * (1 - washed * 0.11)
  const green = shade * (0.96 + warm * 0.05)
  const blue = shade * (0.91 + washed * 0.1 + warm * 0.03)
  return [red, green, blue] as const
}

function boardColors(primitive: Primitive, pieces: readonly FreightPiece[], seed: number) {
  const positions = primitive.getAttribute('POSITION')
  const indices = primitive.getIndices()?.getArray()
  if (
    !(positions && indices) ||
    pieces.reduce((sum, part) => sum + part.indexCount, 0) !== indices.length
  ) {
    throw new Error('Freight mesh no longer matches its authored board topology')
  }
  const data = new Uint8Array(positions.getCount() * 4).fill(255)
  const point: number[] = []
  const age = 0.93 + random(seed, 129) * 0.09
  for (const { name, firstIndex, indexCount } of pieces) {
    const tone = pieceTone(name, seed)
    for (let i = firstIndex; i < firstIndex + indexCount; i++) {
      const vertex = indices[i]
      if (vertex === undefined) {
        throw new Error('Missing authored freight board vertex')
      }
      const [x = 0, y = 0, z = 0] = positions.getElement(vertex, point)
      const stain = smooth(y / 0.5)
      const grain = 0.93 + 0.07 * field(x * 2.4 + seed, z * 2.4 + y * 0.9)
      const wear = age * grain * (0.92 + 0.08 * stain)
      for (const [channel, factor] of tone.entries()) {
        data[vertex * 4 + channel] = clampByte(factor * wear * 255)
      }
    }
  }
  return data
}

function colorFreightCell(
  doc: Document,
  node: Node,
  manifest: ReadonlyMap<string, readonly FreightPiece[]>,
): number {
  const original = node.getMesh()
  const holder = node.getParentNode()
  const cell = holder?.getParentNode()?.getName()
  const pieces = manifest.get(holder?.getName() ?? '')
  const primitive = original?.listPrimitives()[0]
  if (!(cell && primitive && original && pieces && original.listPrimitives().length === 1)) {
    throw new Error('Missing freight case body and board metadata')
  }
  const seed = [...cell].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0), 31)
  const color = doc
    .createAccessor()
    .setArray(boardColors(primitive, pieces, seed))
    .setNormalized(true)
    .setType('VEC4')
    .setBuffer(primitive.getAttribute('POSITION')?.getBuffer() ?? null)
  const renamed = doc
    .createMesh(original.getName())
    .addPrimitive(primitive.clone().setAttribute('COLOR_0', color))
  node.setMesh(renamed)
  return 1
}

async function installFreightFinish(doc: Document): Promise<number> {
  const source = JSON.parse(await readFile(FREIGHT, 'utf8')) as FreightPrefabManifest
  const pieces = new Map(
    source.prototypes.map(([label, proto]) => [
      label,
      proto.pieces.filter((part) => part.role === 'body'),
    ]),
  )
  const nodes = doc.getRoot().listNodes()
  const bodies: Node[] = []
  for (const target of COVER_IDS) {
    const group = nodes.find(
      (node) =>
        node.getName().startsWith('model-lod:') && node.getName().endsWith(`:freight-${target}`),
    )
    if (!group) {
      throw new Error(`Missing large freight set ${target}`)
    }
    group.traverse((node) => {
      if (node.getExtras().freightRole === 'body') {
        bodies.push(node)
      }
    })
  }
  return bodies.reduce((count, node) => count + colorFreightCell(doc, node, pieces), 0)
}

/** Call from the Frontier environment bake after canonical freight and timber are loaded. */
export async function varyPerditionRoofsAndFreight(doc: Document) {
  const root = doc.getRoot()
  if (root.getExtras()[VERSION]) {
    return { roofVertices: 0, freightBodies: 0 }
  }
  const roofVertices = await installCedar(doc)
  const freightBodies = await installFreightFinish(doc)
  root.setExtras({ ...root.getExtras(), [VERSION]: 1 })
  return { roofVertices, freightBodies }
}

if (import.meta.main) {
  const [base, output, resources] = process.argv.slice(2)
  if (!(base && output && resources) || resolve(base) === resolve(output)) {
    throw new Error(
      'Usage: bun tools/content/frontier-roof-freight-variation.ts BASE.glb OUTPUT.glb CACHE_DIR',
    )
  }
  await mkdir(resolve(resources), { recursive: true })
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const doc = await io.read(base)
  console.log(await withContentOutput(resources, () => varyPerditionRoofsAndFreight(doc)))
  await io.write(output, doc)
  console.log(await packFrontierMap(output, resources))
  const size = (await stat(output)).size
  if (size >= 100 * 1024 * 1024) {
    throw new Error(`Perdition map exceeds 100 MiB: ${size} bytes`)
  }
  console.log({ size })
}
