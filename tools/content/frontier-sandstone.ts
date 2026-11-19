/** Offline cylindrical surface charts for the two upper Frontier rock formations. */
import type { Accessor, Document, Material, TextureInfo } from '@gltf-transform/core'
import { KHRTextureTransform } from '@gltf-transform/extensions'
import { calculateTangents } from 'playcanvas'
import sharp from 'sharp'

type Course = readonly [height: number, recess: number, shelf: number, strength: number]
type Coordinates = [number, number]
type Triangle = [number, number, number]

const RESOLUTION = 256
const SOURCE_RESOLUTION = 512
const TILES = [
  {
    name: 'north',
    center: [0.5, -40.2],
    radii: [14.5, 11.8],
    floor: 8.8,
    crown: 19.2,
    phase: 1.3,
    courses: [
      [10.75, 0.2, 0.52, 0.73],
      [12.7, 0.32, 0.3, 0.94],
      [15.5, 0.14, 0.46, 0.61],
      [17.05, 0.3, 0.27, 0.91],
    ],
  },
  {
    name: 'west',
    center: [-24.1, 59.5],
    radii: [10.1, 10.8],
    floor: 5.2,
    crown: 14.5,
    phase: -0.7,
    courses: [
      [6.65, 0.17, 0.26, 0.73],
      [8.27, 0.35, 0.45, 0.99],
      [10.35, 0.19, 0.5, 0.89],
      [11.87, 0.26, 0.29, 0.66],
    ],
  },
] as const satisfies readonly {
  name: string
  center: Coordinates
  radii: Coordinates
  floor: number
  crown: number
  phase: number
  courses: readonly Course[]
}[]
type Tile = (typeof TILES)[number]

interface Ground {
  positions: Float32Array
  normals: Int16Array
  colors: Uint8Array
  dirtUv: Float32Array
  cloudUv: Float32Array
}

interface Trace {
  x: number
  y: number
  z: number
  u: number
  v: number
  normalY: number
}
type TraceTriangle = [Trace, Trace, Trace]

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const smooth = (value: number) => {
  const t = clamp(value)
  return t * t * (3 - 2 * t)
}

const position = (ground: Ground, index: number) =>
  [
    ground.positions[index * 3] ?? 0,
    ground.positions[index * 3 + 1] ?? 0,
    ground.positions[index * 3 + 2] ?? 0,
  ] as const

const relative = (tile: Tile, x: number, z: number): Coordinates => [
  (x - tile.center[0]) / tile.radii[0],
  (z - tile.center[1]) / tile.radii[1],
]

function chartPoint(tile: Tile, [x, y, z]: readonly [number, number, number]): Coordinates {
  const [a, b] = relative(tile, x, z)
  // The wrap lies on the side away from town. Radius keeps texel area on the flatter shelves.
  const angle = tile.name === 'north' ? Math.atan2(a, b) : Math.atan2(b, a)
  const course = y - tile.floor - 4 * Math.hypot(a, b) + 5.5
  return [
    (0.5 + angle / (2 * Math.PI)) * RESOLUTION,
    (1 - course / (tile.crown - tile.floor + 6.6)) * RESOLUTION,
  ]
}

function sample(image: Buffer, u: number, v: number, component: number) {
  const x = (u - Math.floor(u)) * SOURCE_RESOLUTION - 0.5
  const y = (v - Math.floor(v)) * SOURCE_RESOLUTION - 0.5
  const column = Math.floor(x)
  const row = Math.floor(y)
  const dx = x - column
  const dy = y - row
  const mask = SOURCE_RESOLUTION - 1
  const at = (a: number, b: number) =>
    image[((b & mask) * SOURCE_RESOLUTION + (a & mask)) * 3 + component] ?? 0
  return (
    (at(column, row) * (1 - dx) + at(column + 1, row) * dx) * (1 - dy) +
    (at(column, row + 1) * (1 - dx) + at(column + 1, row + 1) * dx) * dy
  )
}

function bands(tile: Tile, point: Trace, a: number, b: number) {
  const { y, normalY } = point
  const angle = Math.atan2(b, a)
  const height = y - (a * 0.72 - b * 0.35) - 0.2 * Math.sin(a * 8.2 + b * 4.8 + tile.phase)
  let recess = 0
  let shoulder = 0
  for (const [elevation, narrow, broad, strength] of tile.courses) {
    const wave = Math.sin(angle * 6 + elevation)
    const breakLine = elevation + 0.13 * wave + 0.065 * Math.cos(angle * 15 + narrow * 70)
    const localWidth = 1 + 0.3 * Math.cos(angle * 3 - elevation)
    const distance = height - breakLine
    const depression = (distance - 0.09) / (narrow * localWidth)
    const shelf = (distance + 0.22) / (broad * localWidth)
    recess = Math.max(recess, strength * Math.exp(-(depression ** 2)))
    shoulder = Math.max(shoulder, strength * Math.exp(-(shelf ** 2)))
  }
  return {
    u: ((tile.radii[0] + tile.radii[1]) * 0.5 * angle) / 3.3,
    v: y / 2.8,
    minerals: 0.5 + 0.5 * Math.sin(height * 2.5 + Math.sin(a * 4 - b * 5) * 0.4),
    fade:
      smooth((y - tile.floor - 0.12) / 2.45) *
      smooth((1.04 - Math.hypot(a, b)) / 0.27) *
      (0.61 + 0.39 * smooth((0.91 - normalY) / 0.37)),
    recess,
    shoulder,
  }
}

function trace(ground: Ground, index: number): Trace {
  const [x, y, z] = position(ground, index)
  return {
    x,
    y,
    z,
    u: ground.dirtUv[index * 2] ?? 0,
    v: ground.dirtUv[index * 2 + 1] ?? 0,
    normalY: (ground.normals[3 * index + 1] ?? 32_767) / 32_767,
  }
}

function interpolate(values: TraceTriangle, a: number, b: number): Trace {
  const [first, second, third] = values
  const c = 1 - a - b
  const at = (key: keyof Trace) => first[key] * c + second[key] * a + third[key] * b
  return { x: at('x'), y: at('y'), z: at('z'), u: at('u'), v: at('v'), normalY: at('normalY') }
}

function surfaceTexture(tile: Tile, dirt: Buffer, stone: Buffer) {
  const pixels = Buffer.alloc(RESOLUTION * RESOLUTION * 3)
  const heights = new Float32Array(RESOLUTION * RESOLUTION).fill(Number.NEGATIVE_INFINITY)
  const paint = (index: number, point: Trace) => {
    if (point.y <= (heights[index] ?? Number.POSITIVE_INFINITY)) {
      return
    }
    heights[index] = point.y
    const [a, b] = relative(tile, point.x, point.z)
    const bed = bands(tile, point, a, b)
    const litStone = [0.984, 0.964, 0.958]
    const pale = [15, 19, 22]
    const eroded = [48, 44, 40]
    for (let component = 0; component < 3; component++) {
      const grain = sample(stone, bed.u, bed.v, component)
      const color = clamp(
        grain * (litStone[component] ?? 1) * (1 - 0.12 * bed.minerals) +
          bed.shoulder * (pale[component] ?? 0) -
          bed.recess * (eroded[component] ?? 0),
        0,
        255,
      )
      const soil = sample(dirt, point.u, point.v, component)
      pixels[index * 3 + component] = Math.round(color * bed.fade + soil * (1 - bed.fade))
    }
  }
  return { pixels, heights, paint }
}

function rasterize(
  values: TraceTriangle,
  chart: [Coordinates, Coordinates, Coordinates],
  paint: ReturnType<typeof surfaceTexture>['paint'],
) {
  const [[x0, y0], [x1, y1], [x2, y2]] = chart
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  if (!area) {
    return
  }
  const left = Math.floor(Math.min(x0, x1, x2))
  const right = Math.ceil(Math.max(x0, x1, x2))
  const top = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
  const bottom = Math.min(RESOLUTION - 1, Math.ceil(Math.max(y0, y1, y2)))
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) {
      const x = column + 0.5 - x0
      const y = row + 0.5 - y0
      const a = (x * (y2 - y0) - y * (x2 - x0)) / area
      const b = ((x1 - x0) * y - (y1 - y0) * x) / area
      if (Math.min(a, b, 1 - a - b) >= -1e-6) {
        paint(row * RESOLUTION + (column & (RESOLUTION - 1)), interpolate(values, a, b))
      }
    }
  }
}

function fillGutter({ pixels, heights }: ReturnType<typeof surfaceTexture>) {
  for (let sweep = 0; sweep < 4; sweep++) {
    const written = new Float32Array(heights)
    for (let row = 1; row < RESOLUTION - 1; row++) {
      for (let column = 0; column < RESOLUTION; column++) {
        const index = row * RESOLUTION + column
        if ((written[index] ?? Number.POSITIVE_INFINITY) > Number.NEGATIVE_INFINITY) {
          continue
        }
        const wrap = (offset: number) => row * RESOLUTION + ((column + offset) & (RESOLUTION - 1))
        const source = [wrap(-1), wrap(1), index - RESOLUTION, index + RESOLUTION].find(
          (adjacent) => (written[adjacent] ?? Number.NEGATIVE_INFINITY) > Number.NEGATIVE_INFINITY,
        )
        if (source !== undefined) {
          heights[index] = written[source] ?? Number.NEGATIVE_INFINITY
          pixels.copy(pixels, index * 3, source * 3, source * 3 + 3)
        }
      }
    }
  }
}

function nearTile(tile: Tile, ground: Ground, face: Triangle) {
  const points = face.map((index) => position(ground, index))
  const radii = points.map(([x, , z]) => Math.hypot(...relative(tile, x, z)))
  return radii.every((radius) => radius < 1.2) && points.some(([, y]) => y > tile.floor + 0.06)
}

function projectFace(tile: Tile, points: TraceTriangle): [Coordinates, Coordinates, Coordinates] {
  const chart = points.map(({ x, y, z }) => chartPoint(tile, [x, y, z])) as [
    Coordinates,
    Coordinates,
    Coordinates,
  ]
  const columns = chart.map(([column]) => column)
  if (Math.max(...columns) - Math.min(...columns) > RESOLUTION / 2) {
    for (const pair of chart) {
      if (pair[0] < RESOLUTION / 2) {
        pair[0] += RESOLUTION
      }
    }
  }
  return chart
}

function chartGeometry(ground: Ground) {
  const vertices = new Map<string, number>()
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const coordinates: number[] = []
  const clouds: number[] = []
  const indices: number[] = []
  function add(
    [a, b, c]: Triangle,
    [first, second, third]: [Coordinates, Coordinates, Coordinates],
  ) {
    for (const [index, [u, v]] of [
      [a, first],
      [b, second],
      [c, third],
    ] as const) {
      const key = `${index}:${Number(u > RESOLUTION)}`
      let vertex = vertices.get(key)
      if (vertex === undefined) {
        vertex = positions.length / 3
        vertices.set(key, vertex)
        positions.push(...position(ground, index))
        normals.push(...ground.normals.slice(index * 3, index * 3 + 3))
        colors.push(...ground.colors.slice(index * 4, index * 4 + 4))
        clouds.push(...ground.cloudUv.slice(index * 2, index * 2 + 2))
        coordinates.push(u / RESOLUTION, v / RESOLUTION)
      }
      indices.push(vertex)
    }
  }
  return { positions, normals, colors, coordinates, clouds, indices, add }
}

function addRockPrimitive(
  material: Material,
  model: { document: Document; buffer: NonNullable<ReturnType<Accessor['getBuffer']>> },
  geometry: ReturnType<typeof chartGeometry>,
) {
  const { document, buffer } = model
  const { positions, normals, colors, coordinates, clouds, indices } = geometry
  const accessor = (
    type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR',
    array: Parameters<Accessor['setArray']>[0],
  ) => document.createAccessor().setBuffer(buffer).setType(type).setArray(array)
  const tangents = calculateTangents(
    positions,
    normals.map((value) => value / 32_767),
    coordinates,
    indices,
  )
  const packedTangents = Int16Array.from(tangents, (part) =>
    Math.round(clamp(part, -1, 1) * 32_767),
  )
  return document
    .createPrimitive()
    .setMaterial(material)
    .setIndices(accessor('SCALAR', Uint16Array.from(indices)))
    .setAttribute('POSITION', accessor('VEC3', Float32Array.from(positions)))
    .setAttribute('TEXCOORD_0', accessor('VEC2', Float32Array.from(coordinates)))
    .setAttribute('TEXCOORD_1', accessor('VEC2', Float32Array.from(clouds)))
    .setAttribute('NORMAL', accessor('VEC3', Int16Array.from(normals)).setNormalized(true))
    .setAttribute('COLOR_0', accessor('VEC4', Uint8Array.from(colors)).setNormalized(true))
    .setAttribute('TANGENT', accessor('VEC4', packedTangents).setNormalized(true))
}

const readTile = async (path: string) =>
  sharp(path).removeAlpha().resize(SOURCE_RESOLUTION, SOURCE_RESOLUTION).raw().toBuffer()

/** Preserves every upper-rock vertex, the original normals, and the independent cloud coordinates. */
export async function installFrontierSandstone(document: Document) {
  const root = document.getRoot()
  const mesh = root
    .listMeshes()
    .find((candidate) => candidate.getName() === 'ground-Perdition:ground')
  const land = mesh?.listPrimitives()[0]
  const masonry = root
    .listMaterials()
    .find((material) => material.getName() === 'Perdition dressed stone')
  const positionAttribute = land?.getAttribute('POSITION')
  const buffer = positionAttribute?.getBuffer()
  const positions = positionAttribute?.getArray()
  const normals = land?.getAttribute('NORMAL')?.getArray()
  const colors = land?.getAttribute('COLOR_0')?.getArray()
  const dirtUv = land?.getAttribute('TEXCOORD_0')?.getArray()
  const cloudUv = land?.getAttribute('TEXCOORD_1')?.getArray()
  const landIndices = land?.getIndices()
  const source = landIndices?.getArray()
  if (
    !(
      mesh &&
      masonry &&
      buffer &&
      landIndices &&
      positions instanceof Float32Array &&
      normals instanceof Int16Array &&
      colors instanceof Uint8Array &&
      dirtUv instanceof Float32Array &&
      cloudUv instanceof Float32Array &&
      source instanceof Uint16Array
    )
  ) {
    throw new Error('Cannot find the packed Frontier terrain and shared sandstone material')
  }
  const ground = { positions, normals, colors, dirtUv, cloudUv }
  const [dirt, stone] = await Promise.all([
    readTile('public/experiments/out-west/3d/tex/ground_diff.webp'),
    readTile('tools/art/environments/textures/sandstone_cracks_diff.webp'),
  ])
  const faces: [Triangle, Tile | undefined][] = []
  const apron: number[] = []
  for (let index = 0; index < source.length; index += 3) {
    const face: Triangle = [source[index] ?? 0, source[index + 1] ?? 0, source[index + 2] ?? 0]
    const owner = TILES.find((tile) => nearTile(tile, ground, face))
    faces.push([face, owner])
    if (!owner) {
      apron.push(...face)
    }
  }
  const transform = document.createExtension(KHRTextureTransform)
  const normal = masonry.getNormalTexture()
  const arm = masonry.getMetallicRoughnessTexture()
  const repeat = (info: TextureInfo | null) =>
    info?.setExtension('KHR_texture_transform', transform.createTransform().setScale([18, 6]))
  for (const tile of TILES) {
    const texture = surfaceTexture(tile, dirt, stone)
    const geometry = chartGeometry(ground)
    for (const [face, owner] of faces) {
      const points = face.map((index) => trace(ground, index)) as TraceTriangle
      // Bake texels beyond the material seam so the lower alpha-free transition retains dirt.
      if (
        points.every(({ x, z }) => relative(tile, x, z).every((axis) => Math.abs(axis) < 1.3)) &&
        points.some(({ y }) => y >= tile.floor - 0.8)
      ) {
        const projected = projectFace(tile, points)
        rasterize(points, projected, texture.paint)
        if (tile === owner) {
          geometry.add(face, projected)
        }
      }
    }
    if (geometry.indices.length < 1000) {
      throw new Error(`Missing upper-rock faces for the ${tile.name} Frontier sandstone chart`)
    }
    fillGutter(texture)
    const image = await sharp(texture.pixels, {
      raw: { width: RESOLUTION, height: RESOLUTION, channels: 3 },
    })
      .png()
      .toBuffer()
    const diffuse = document
      .createTexture(`Frontier sandstone course ${tile.name}`)
      .setImage(image)
      .setMimeType('image/png')
    const material = document
      .createMaterial(`Perdition weathered sandstone ${tile.name}`)
      .setBaseColorTexture(diffuse)
      .setNormalTexture(normal)
      .setNormalScale(0.38)
      .setMetallicRoughnessTexture(arm)
      .setMetallicFactor(0)
      .setRoughnessFactor(0.96)
    repeat(material.getNormalTextureInfo())
    repeat(material.getMetallicRoughnessTextureInfo())
    mesh.addPrimitive(addRockPrimitive(material, { document, buffer }, geometry))
  }
  landIndices.setArray(Uint16Array.from(apron))
}
