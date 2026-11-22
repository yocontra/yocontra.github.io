/** Bake Quick Draw facade finishes into the existing native materials and vertex streams. */
import type { Document, Node, Primitive, Texture, vec3 } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import sharp from 'sharp'

type Arena = 'duel' | 'depot' | 'mission' | 'bank'
type Tint = (position: vec3, vertical: number) => vec3
interface Paint {
  side: 1 | -1
  z: number
  span: number
  pigment: vec3
}
const PAINT: Record<Exclude<Arena, 'mission'>, readonly Paint[]> = {
  duel: [
    { side: 1, z: 2, span: 7, pigment: [1.32, 0.69, 0.59] },
    { side: 1, z: 15, span: 7, pigment: [0.72, 1.23, 1.14] },
    { side: 1, z: 30, span: 7, pigment: [1.31, 1.28, 1.15] },
    { side: -1, z: 5.5, span: 7, pigment: [0.84, 1.16, 1.16] },
    { side: -1, z: 18, span: 7, pigment: [1.27, 0.87, 0.6] },
    { side: -1, z: 30, span: 7, pigment: [0.81, 1.12, 1.3] },
  ],
  depot: [
    { side: 1, z: 10, span: 18, pigment: [1.43, 1.41, 1.29] },
    { side: -1, z: 5, span: 15, pigment: [1.26, 0.68, 0.55] },
  ],
  bank: [
    { side: 1, z: 2, span: 8, pigment: [0.67, 0.92, 1.52] },
    { side: 1, z: 15, span: 8, pigment: [1.29, 0.8, 0.62] },
    { side: 1, z: 30, span: 8, pigment: [1.15, 1.12, 0.98] },
    { side: -1, z: 5.5, span: 8, pigment: [1.17, 0.79, 0.72] },
    { side: -1, z: 18, span: 8, pigment: [0.71, 1.24, 1.55] },
    { side: -1, z: 30, span: 8, pigment: [1.15, 1.18, 1.07] },
  ],
}
const FRONTAGES: Record<Arena, readonly string[]> = {
  duel: ['walls-7', 'kit-5'],
  depot: ['walls-0', 'kit-6', 'trim-1'],
  mission: ['adobe-6', 'masonry-7'],
  bank: ['walls-0', 'kit-5', 'masonry-3'],
}
const EXPOSURE: Record<Arena, number> = { duel: 1, depot: 1.66, mission: 1.35, bank: 1.18 }
const PHASES = [0.07, 0.58, 0.27, 0.86] as const
const PATCH = 448
const HEIGHT = 704

function smooth(value: number): number {
  const t = Math.min(1, Math.max(0, value))
  return t * t * (3 - 2 * t)
}
function fraction(value: number): number {
  return value - Math.floor(value)
}
function grain(x: number, z: number): number {
  return fraction(Math.sin(127.1 * x + 311.7 * z) * 43_758.5453)
}
function weather(x: number, z: number): number {
  const left = Math.floor(x)
  const near = Math.floor(z)
  const s = smooth(x - left)
  const t = smooth(z - near)
  const a = grain(left, near) * (1 - s) + grain(left + 1, near) * s
  const b = grain(left, near + 1) * (1 - s) + grain(left + 1, near + 1) * s
  return a + (b - a) * t
}

function wallTint(position: readonly number[], vertical: number, paint: readonly Paint[]): vec3 {
  const [x = 0, y = 0, z = 0] = position
  const side = x < 0 ? -1 : 1
  const washed = weather(x / 5.5, z / 8.6)
  const rain = weather(x / 0.95, z / 2.65)
  const baseDamp = 1 - smooth((y - 0.12) / 2.4)
  const wear = 0.84 + washed * 0.21 - baseDamp * rain * 0.14
  const colors: vec3 = [1, 1, 1]
  for (const site of paint) {
    const width = Math.abs(z - site.z)
    if (site.side !== side || width >= site.span + 1.5) {
      continue
    }
    const amount =
      vertical *
      (1 - smooth((width - site.span + 1.5) / 3)) *
      (0.78 + washed * 0.22) *
      (0.65 + smooth(y / 2.2) * 0.35)
    for (const [channel, pigment] of site.pigment.entries()) {
      colors[channel] = (colors[channel] ?? 1) * (1 + (pigment - 1) * amount)
    }
  }
  return [colors[0] * wear, colors[1] * wear, colors[2] * (wear * 0.99 + rain * 0.02)]
}

function depotTint(trim: boolean): Tint {
  return ([x, y, z], vertical) => {
    const passenger = smooth((x - 8.3) / 1.1) * (1 - smooth((z - 26) / 4.5))
    const plank = weather(x / 1.4 + 5, z / 3.6)
    const worn = smooth((plank - 0.19) / 0.65)
    if (trim) {
      const floor = passenger * (1 - vertical) * (1 - smooth((y - 0.35) / 0.2))
      const walk = floor * (0.45 + worn * 0.55)
      // The passenger enclosure boards sit behind their posts and the old exposed lower rail.
      const panel =
        passenger * vertical * smooth((x - 12.65) / 0.26) * (1 - smooth((y - 4.24) / 0.43))
      const wash = panel * (0.67 + 0.33 * worn)
      return [
        1 + walk * 0.22 + wash * 0.12,
        1 + walk * 0.45 + wash * 0.55,
        1 + walk * 0.57 + wash * 0.77,
      ]
    }
    const original = wallTint([x, y, z], vertical, PAINT.depot)
    const wash = passenger * vertical * (0.74 + 0.26 * worn)
    return [
      original[0] * (0.98 + wash * 0.19),
      original[1] * (0.98 + wash * 0.46),
      original[2] * (0.98 + wash * 0.66),
    ]
  }
}

function missionTint(adobe: boolean): Tint {
  return ([x, y, z], vertical) => {
    const along = Math.abs(x) < 7 ? x : z
    const wall = Math.abs(x) < 7 ? z : x
    const exposure = weather(along / 7.2, wall / 2.2)
    const runoff = weather(along / 1.24 + 6.2, y / 4.8 + wall * 0.26)
    const scuff = weather(along / 0.76, y / 0.7 + wall * 0.37)
    const damp = (1 - smooth((y - 0.12) / (0.82 + scuff * 0.46))) * (0.24 + runoff * 0.2)
    const light = 0.94 + exposure * 0.19 - damp
    // Fresh patches carry more lime. The exposed clay below stays warmer.
    const lime = vertical * smooth((exposure * 0.55 + runoff * 0.45 - 0.25) / 0.56)
    if (adobe) {
      return [
        light * (0.92 + lime * 0.26),
        light * (0.93 + lime * 0.61),
        light * (0.83 + lime * 0.94),
      ]
    }
    const chapel = smooth((z - 42) / 6) * (1 - smooth((Math.abs(x) - 7) / 3))
    const stain = vertical * ((1 - runoff) * 0.23 + (1 - scuff) * 0.12)
    const stone = light * (1.03 - stain + lime * 0.16 + chapel * 0.16)
    return [
      stone * (1 - lime * 0.06),
      stone * (1.03 + chapel * 0.09),
      stone * (0.96 + lime * 0.3 + chapel * 0.18),
    ]
  }
}

function bankMasonry(limestone: boolean): Tint {
  return ([x, y, z], vertical) => {
    const main = smooth((z - 38) / 4) * (1 - smooth((Math.abs(x) - 6) / 2))
    const grime = weather((x - z) / 1.8, y / 2.7)
    const firing = weather(x / 1.7 + 12, z / 3.4)
    const waterline = (1 - smooth((y - 0.1) / (0.68 + grime * 0.74))) * (0.16 + 0.21 * grime)
    const shade = 0.87 + firing * 0.23 - vertical * waterline
    if (limestone) {
      const mineral = shade * (0.91 + 0.14 * grime + main * 0.19)
      return [
        mineral * (0.96 + grime * 0.04),
        mineral,
        mineral * (0.96 + grime * 0.27 + main * 0.17),
      ]
    }
    const finish = wallTint([x, y, z], vertical, PAINT.bank)
    const face = shade + 0.15 * main
    return [finish[0] * face, finish[1] * face, finish[2] * (face + 0.07 * firing)]
  }
}

function paintVertices(
  doc: Document,
  node: Node,
  primitive: Primitive,
  { tint, exposure }: { tint: Tint; exposure: number },
) {
  const position = primitive.getAttribute('POSITION')
  const normal = primitive.getAttribute('NORMAL')
  const previous = primitive.getAttribute('COLOR_0')
  const buffer = position?.getBuffer()
  if (!(position && normal && buffer)) {
    throw new Error('Expected a baked arena facade with positions and normals')
  }
  const color = new Float32Array(position.getCount() * 4)
  const p = [0, 0, 0]
  const n = [0, 0, 0]
  const old = [1, 1, 1, 1]
  const toWorld = new Mat4().set(node.getWorldMatrix())
  const point = new Vec3()
  const direction = new Vec3()
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, p)
    normal.getElement(i, n)
    previous?.getElement(i, old)
    toWorld.transformPoint(point.set(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0), point)
    toWorld.transformVector(direction.set(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0), direction).normalize()
    const vertical = 1 - smooth((Math.abs(direction.y) - 0.1) / 0.5)
    const factors = tint([point.x, point.y, point.z], vertical)
    for (const [channel, factor] of factors.entries()) {
      color[i * 4 + channel] = Math.min(1, Math.max(0, ((old[channel] ?? 1) * factor) / exposure))
    }
    // Existing vertex alpha belongs to the source material.
    color[i * 4 + 3] = old[3] ?? 1
  }
  primitive.setAttribute(
    'COLOR_0',
    doc.createAccessor().setType('VEC4').setArray(color).setBuffer(buffer),
  )
}

function dirtTint(doc: Document): void {
  const node = doc
    .getRoot()
    .listNodes()
    .find((entry) => entry.getName() === 'ground-18')
  const primitive = node?.getMesh()?.listPrimitives()[0]
  const position = primitive?.getAttribute('POSITION')
  const buffer = position?.getBuffer()
  if (!(node && primitive && position && buffer) || primitive.getAttribute('COLOR_0')) {
    throw new Error('Expected unpainted regular arena terrain positions')
  }
  const color = new Float32Array(position.getCount() * 3)
  const toWorld = new Mat4().set(node.getWorldMatrix())
  const point = new Vec3()
  const local = [0, 0, 0]
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, local)
    toWorld.transformPoint(point.set(local[0] ?? 0, local[1] ?? 0, local[2] ?? 0), point)
    const { x, y, z } = point
    const coarse = weather(x / 21 + 21, z / 26 - 7)
    const drift = weather((x + z * 0.32) / 12, (z - x * 0.15) / 19)
    const road = 1 - smooth((Math.abs(x) - 7) / 12)
    const grade = (1 - smooth((y - 0.4) / 1.8)) * (0.48 + 0.52 * road)
    const shade = 1 - grade * (0.32 - coarse * 0.22 - drift * 0.08)
    const silt = grade * drift * (1 - road)
    color[i * 3] = shade * (1 - silt * 0.06)
    color[i * 3 + 1] = shade
    color[i * 3 + 2] = Math.min(1, shade * (1 + silt * 0.14))
  }
  primitive.setAttribute(
    'COLOR_0',
    doc.createAccessor().setType('VEC3').setArray(color).setBuffer(buffer),
  )
}

function stoneStains(
  position: readonly [number, number],
  cells: readonly [number, number],
): number {
  const [u, v] = position
  const [width, height] = cells
  const x = u * width
  const y = v * height
  const column = Math.floor(x)
  const row = Math.floor(y)
  const left = smooth(x - column)
  const top = smooth(y - row)
  const sample = (i: number, j: number) => grain((i % width) + 13, (j % height) + 26)
  const a = sample(column, row) * (1 - left) + sample(column + 1, row) * left
  const b = sample(column, row + 1) * (1 - left) + sample(column + 1, row + 1) * left
  return a * (1 - top) + b * top
}

function stonePatina(u: number, v: number): number {
  const stains = smooth((stoneStains([u, v], [7, 3]) - 0.26) / 0.62)
  const minerals = stoneStains([u, v], [59, 19])
  return 0.95 + stains * 0.1 + (minerals - 0.5) * 0.07
}

async function longSurfaceMap(
  image: Uint8Array,
  { masonry, albedo }: { masonry: boolean; albedo: boolean },
): Promise<Buffer> {
  const patch = masonry ? 320 : PATCH
  const height = masonry ? 480 : HEIGHT
  const width = PHASES.length * patch
  const input = await sharp(image)
    .removeAlpha()
    .toColourspace('srgb')
    .resize(patch, height)
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (input.info.channels !== 3) {
    throw new Error('Arena surface texture must use three channels')
  }
  const row = Array.from({ length: width }, (_, x) => {
    const segment = Math.floor(x / patch)
    const local = fraction(x / patch)
    const mix = smooth((local - 0.73) / 0.27)
    // Keep masonry course joints aligned. Only wood shifts its grain between sections.
    const phase = masonry ? 0 : (PHASES[segment] ?? 0)
    const next = masonry ? 0 : (PHASES[(segment + 1) % PHASES.length] ?? 0)
    return [
      Math.floor(fraction(local + phase) * patch),
      Math.floor(fraction(local + next) * patch),
      mix,
    ] as const
  })
  const output = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (const [x, [a, b, mix]] of row.entries()) {
      const patina = masonry && albedo ? stonePatina(x / width, y / height) : 1
      for (let channel = 0; channel < 3; channel++) {
        const first = input.data[(y * patch + a) * 3 + channel] ?? 0
        const second = input.data[(y * patch + b) * 3 + channel] ?? 0
        output[(y * width + x) * 3 + channel] = Math.round(
          Math.min(255, (first * (1 - mix) + second * mix) * patina),
        )
      }
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } })
    .webp({ lossless: true })
    .toBuffer()
}

async function replaceSurfaceMaps(
  doc: Document,
  primitive: Primitive,
  masonry: boolean,
): Promise<void> {
  const material = primitive.getMaterial()
  const coordinates = primitive.getAttribute('TEXCOORD_0')
  const uv = coordinates?.getArray()
  if (!(material && coordinates && uv instanceof Float32Array)) {
    throw new Error('Expected float UVs on regular arena surfaces')
  }
  const maps = [
    [material.getBaseColorTexture(), (texture: Texture) => material.setBaseColorTexture(texture)],
    [material.getNormalTexture(), (texture: Texture) => material.setNormalTexture(texture)],
    [
      material.getMetallicRoughnessTexture(),
      (texture: Texture) => material.setMetallicRoughnessTexture(texture),
    ],
    [material.getOcclusionTexture(), (texture: Texture) => material.setOcclusionTexture(texture)],
  ] as const
  const baked = new Map<Texture, Texture>()
  for (const [source, write] of maps) {
    const image = source?.getImage()
    if (!(source && image)) {
      continue
    }
    let texture = baked.get(source)
    if (!texture) {
      texture = doc
        .createTexture(masonry ? 'Arena stone patina' : 'Arena long board grain')
        .setImage(
          await longSurfaceMap(image, {
            masonry,
            albedo: material.getBaseColorTexture() === source,
          }),
        )
        .setMimeType('image/webp')
      baked.set(source, texture)
    }
    write(texture)
  }
  // Preserve vertical courses and align the phase changes in every map.
  primitive.setAttribute(
    'TEXCOORD_0',
    coordinates.clone().setArray(uv.map((v, index) => (index % 2 === 0 ? v / PHASES.length : v))),
  )
}

function facadeTint(name: Arena, label: string, material: string): Tint {
  if (name === 'mission') {
    return missionTint(label === 'adobe-6')
  }
  if (name === 'depot') {
    return depotTint(label === 'trim-1')
  }
  if (name === 'bank' && label === 'masonry-3') {
    return bankMasonry(material === 'Masonry-1')
  }
  return (position, vertical) => wallTint(position, vertical, PAINT[name])
}

export async function applyArenaFacadeWear(
  doc: Document,
  name: Arena,
  { paintOnly = false } = {},
): Promise<void> {
  const wanted = FRONTAGES[name]
  const visited = new Set<string>()
  for (const node of doc.getRoot().listNodes()) {
    const label = node.getName()
    if (!wanted.includes(label)) {
      continue
    }
    const parts = node.getMesh()?.listPrimitives() ?? []
    for (const part of parts) {
      const material = part.getMaterial()
      if (!material) {
        throw new Error(`Missing material for ${label}`)
      }
      const wall = label.startsWith('walls-')
      const masonry = label.startsWith('masonry-') && material.getName() === 'Masonry-1'
      const exposure = label.startsWith('kit-') ? 1.48 : EXPOSURE[name]
      const finish = material.clone()
      const rgb = material.getBaseColorFactor()
      finish.setBaseColorFactor([rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure, rgb[3]])
      part.setMaterial(finish)
      paintVertices(doc, node, part, {
        tint: facadeTint(name, label, material.getName()),
        exposure,
      })
      if ((wall || masonry) && !paintOnly) {
        await replaceSurfaceMaps(doc, part, masonry)
      }
      visited.add(label)
    }
  }
  if (visited.size !== wanted.length) {
    throw new Error(`Missing regular arena frontage in ${name}`)
  }
  if (name === 'duel') {
    dirtTint(doc)
  }
}
