/** Offline finish pass for Perdition's room shells, decks and road-facing siding. */
import { readFile } from 'node:fs/promises'
import type { Accessor, Document, Material, Node, Primitive } from '@gltf-transform/core'
import sharp from 'sharp'
import { WALL_T } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'
import type { Building, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'

type Color = readonly [number, number, number]
type Finish = readonly [floor: Color, wall: Color, plaster?: boolean]

const version = 'perditionJoinery'
const floorGrid = 3
const plasterPath = 'tools/art/environments/textures/clay_plaster'
const plankPath = 'public/experiments/out-west/3d/tex/planks'
const porchTint: Color = [0.71, 0.76, 0.81]
const roomFinishes: Readonly<Record<string, Finish>> = {
  saloon: [
    [0.87, 0.7, 0.5],
    [0.66, 0.4, 0.28],
  ],
  hotel: [[0.93, 0.81, 0.63], [0.76, 0.86, 0.78], true],
  bank: [[0.65, 0.53, 0.44], [0.91, 0.82, 0.65], true],
  general_store: [
    [0.8, 0.74, 0.63],
    [0.74, 0.73, 0.52],
  ],
  church: [[0.69, 0.59, 0.46], [0.79, 0.76, 0.61], true],
  stage_line: [
    [0.7, 0.63, 0.52],
    [0.73, 0.62, 0.38],
  ],
  livery: [
    [0.56, 0.58, 0.54],
    [0.59, 0.48, 0.35],
  ],
  smithy: [
    [0.57, 0.55, 0.52],
    [0.56, 0.49, 0.41],
  ],
  assay: [[0.82, 0.74, 0.64], [0.62, 0.69, 0.68], true],
  undertaker: [
    [0.58, 0.49, 0.39],
    [0.52, 0.53, 0.48],
  ],
  jail: [[0.67, 0.64, 0.58], [0.68, 0.69, 0.66], true],
  hay_barn: [
    [0.58, 0.57, 0.5],
    [0.61, 0.53, 0.36],
  ],
  carriage_shed: [
    [0.6, 0.59, 0.56],
    [0.61, 0.54, 0.42],
  ],
  depot: [[0.78, 0.65, 0.52], [0.66, 0.71, 0.66], true],
}

function hash(x: number, y: number): number {
  let n = Math.imul(x + 31, 0x4_5d_9f_3b) ^ Math.imul(y + 97, 0x11_9d_e1_f3)
  n = Math.imul(n ^ (n >>> 16), 0x4_5d_9f_3b)
  return ((n ^ (n >>> 16)) >>> 0) / 0xff_ff_ff_ff
}

function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

function blend(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function texture(doc: Document, label: string, pixels: Buffer) {
  return doc.createTexture(label).setImage(pixels).setMimeType('image/webp')
}

/** Keep the scan's cross-board seams straight while staggering knots and end joints along each span. */
async function extendedPlanks(kind: string): Promise<Buffer> {
  const size = 1152
  const span = size / floorGrid
  const source = await sharp(await readFile(`${plankPath}_${kind}.webp`))
    .removeAlpha()
    .toColourspace('srgb')
    .resize(span, span)
    .raw()
    .toBuffer()
  const output = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) {
    const row = y % span
    const course = Math.floor((row / span) * 12)
    const rowGroup = Math.floor(y / span)
    const rowPhase = (row / span) * 12 - course
    const phases = Array.from({ length: floorGrid }, (_, board) => {
      const a = hash(board + rowGroup * floorGrid, course)
      const b = hash(board + rowGroup * floorGrid, (course + 1) % 12)
      return Math.round(span * blend(a, b, smooth((rowPhase - 0.82) / 0.18)))
    })
    for (let x = 0; x < size; x++) {
      const board = Math.floor(x / span)
      const along = x % span
      const a = (row * span + ((along + (phases[board] ?? 0)) % span)) * 3
      const b = (row * span + ((along + (phases[(board + 1) % floorGrid] ?? 0)) % span)) * 3
      const t = smooth((along / span - 0.64) / 0.36)
      const weather =
        kind === 'diff'
          ? 0.89 +
            0.22 *
              blend(
                hash(board + rowGroup * floorGrid, course + 47),
                hash(((board + 1) % floorGrid) + rowGroup * floorGrid, course + 47),
                t,
              )
          : 1
      for (let channel = 0; channel < 3; channel++) {
        output[(y * size + x) * 3 + channel] = Math.min(
          255,
          Math.round(weather * blend(source[a + channel] ?? 0, source[b + channel] ?? 0, t)),
        )
      }
    }
  }
  return sharp(output, { raw: { width: size, height: size, channels: 3 } })
    .webp({ lossless: true })
    .toBuffer()
}

async function floorSurface(doc: Document, original: Material): Promise<Material> {
  const [diffuse, normal, arm] = await Promise.all([
    extendedPlanks('diff'),
    extendedPlanks('nor'),
    extendedPlanks('arm'),
  ])
  const armTexture = texture(doc, 'Perdition staggered floorboards arm', arm)
  return original
    .clone()
    .setName('Perdition staggered floorboards')
    .setBaseColorTexture(texture(doc, 'Perdition staggered floorboards diff', diffuse))
    .setNormalTexture(texture(doc, 'Perdition staggered floorboards nor', normal))
    .setMetallicRoughnessTexture(armTexture)
    .setOcclusionTexture(armTexture)
}

async function plasterSurface(doc: Document): Promise<Material> {
  const load = async (kind: string) => {
    let image = sharp(await readFile(`${plasterPath}_${kind}.webp`)).resize(512, 512)
    if (kind === 'diff') {
      // Keep the photographed trowel marks while taking out the clay color.
      image = image.greyscale().linear(0.92, 100)
    }
    return image.webp().toBuffer()
  }
  const [diffuse, normal, arm] = await Promise.all([load('diff'), load('nor'), load('arm')])
  return doc
    .createMaterial('Perdition interior lime plaster')
    .setBaseColorTexture(texture(doc, 'Perdition interior lime plaster diff', diffuse))
    .setNormalTexture(texture(doc, 'Perdition interior lime plaster nor', normal))
    .setNormalScale(0.56)
    .setOcclusionTexture(texture(doc, 'Perdition interior lime plaster arm', arm))
    .setMetallicFactor(0)
    .setRoughnessFactor(0.92)
}

function finishMaterial(material: Material, name: string, tint: Color): Material {
  return material
    .clone()
    .setName(name)
    .setBaseColorFactor([...tint, 1])
}

function floorUv(primitive: Primitive, phase: number): void {
  const uv = primitive.getAttribute('TEXCOORD_0')
  const values = uv?.getArray()
  if (!(uv && values instanceof Float32Array)) {
    throw new Error('Perdition floor needs float UVs')
  }
  const horizontalOffset = hash(phase, 4)
  const verticalOffset = hash(phase, 5)
  primitive.setAttribute(
    'TEXCOORD_0',
    uv
      .clone()
      .setArray(
        values.map(
          (value, index) => value / floorGrid + (index % 2 ? verticalOffset : horizontalOffset),
        ),
      ),
  )
}

function visiblePartition(building: Building, x: number, y: number, z: number): boolean {
  return (building.walls ?? []).some(
    (wall) =>
      x >= wall.x - 0.004 &&
      x <= wall.x + wall.w + 0.004 &&
      z >= wall.z - 0.004 &&
      z <= wall.z + wall.d + 0.004 &&
      y >= (wall.y0 ?? 0) &&
      y <= (wall.y1 ?? building.height),
  )
}

/** The room-side faces have inward normals on the inner shell planes. Door jambs are retained. */
function roomSide(building: Building, points: Accessor, normals: Accessor, triangle: number[]) {
  const [first = 0] = triangle
  const normal = normals.getElement(first, [0, 0, 0])
  const [nx = 0, ny = 0, nz = 0] = normal
  if (Math.abs(ny) > 0.001) {
    return false
  }
  const center = [0, 0, 0]
  const point: number[] = []
  for (const vertex of triangle) {
    points.getElement(vertex, point)
    for (let axis = 0; axis < 3; axis++) {
      center[axis] = (center[axis] ?? 0) + (point[axis] ?? 0) / 3
    }
  }
  const [x = 0, y = 0, z = 0] = center
  const right = building.x + building.w
  const back = building.z + building.d
  if (x < building.x || x > right || z < building.z || z > back) {
    return false
  }
  const within = (position: number, edge: number) => Math.abs(position - edge) < 0.006
  return (
    (nx > 0.999 && within(x, building.x + WALL_T)) ||
    (nx < -0.999 && within(x, right - WALL_T)) ||
    (nz > 0.999 && within(z, building.z + WALL_T)) ||
    (nz < -0.999 && within(z, back - WALL_T)) ||
    visiblePartition(building, x, y, z)
  )
}

function localWall(node: Node, shell: Primitive, building: Building, interior: Material): number {
  const mesh = node.getMesh()
  const positions = shell.getAttribute('POSITION')
  const normals = shell.getAttribute('NORMAL')
  const source = shell.getIndices()
  const indices = source?.getArray()
  if (
    !(
      mesh &&
      positions &&
      normals &&
      source &&
      (indices instanceof Uint16Array || indices instanceof Uint32Array)
    )
  ) {
    throw new Error(`Missing indexed shell for ${building.id}`)
  }
  const indoor: number[] = []
  const outdoor: number[] = []
  for (let i = 0; i < indices.length; i += 3) {
    const trio = Array.from(indices.subarray(i, i + 3))
    const batch = roomSide(building, positions, normals, trio) ? indoor : outdoor
    batch.push(...trio)
  }
  if (indoor.length === 0 || outdoor.length === 0) {
    throw new Error(`Could not isolate room faces for ${building.id}`)
  }
  const width = indices instanceof Uint32Array ? Uint32Array : Uint16Array
  mesh.addPrimitive(
    shell
      .clone()
      .setIndices(source.clone().setArray(new width(indoor)))
      .setMaterial(interior),
  )
  shell.setIndices(source.clone().setArray(new width(outdoor)))
  if (source.listParents().every((parent) => parent.propertyType === 'Root')) {
    source.dispose()
  }
  return indoor.length / 3
}

/** Grade each course by local exposure. One wall's streaks do not repeat on the next facade. */
function weatherSiding(primitive: Primitive, seed: number): void {
  const positions = primitive.getAttribute('POSITION')
  const colors = primitive.getAttribute('COLOR_0')
  if (!(positions && colors)) {
    throw new Error('Painted siding needs position and tint attributes')
  }
  const values = colors.clone()
  const point: number[] = []
  const tint: number[] = []
  for (let i = 0; i < positions.getCount(); i++) {
    const [x = 0, y = 0, z = 0] = positions.getElement(i, point)
    const across = x * 0.59 + z * 0.77
    const cell = Math.floor(across)
    const streak = blend(hash(cell, seed), hash(cell + 1, seed), smooth(across - cell))
    const faded = hash(Math.floor((y + 0.002) / 0.285), seed + 31)
    const splash = 1 - smooth(y / 0.85)
    const intensity = 0.76 + streak * 0.28 + faded * 0.17 - splash * 0.11
    const bleaching = 0.18 * smooth((streak - 0.38) / 0.52)
    colors.getElement(i, tint)
    for (let channel = 0; channel < 3; channel++) {
      tint[channel] = Math.min(1, (tint[channel] ?? 0) * (intensity + channel * bleaching * 0.16))
    }
    values.setElement(i, tint)
  }
  primitive.setAttribute('COLOR_0', values)
  if (colors.listParents().every((parent) => parent.propertyType === 'Root')) {
    colors.dispose()
  }
}

function buildingFloor(
  node: Node,
  source: Material,
  planks: Material,
  { phase, tint, label }: { phase: number; tint: Color; label: string },
): number {
  const primitive = node
    .listChildren()
    .flatMap((child) => child.getMesh()?.listPrimitives() ?? [])
    .find((part) => part.getMaterial() === source)
  if (!primitive) {
    throw new Error(`Missing floor for ${node.getName()}`)
  }
  floorUv(primitive, phase)
  primitive.setMaterial(finishMaterial(planks, `Perdition ${label}`, tint))
  return 1
}

function roomShell(node: Node, building: Building) {
  const children = node.listChildren()
  const siding = children.find((child) => child.getName().includes(':siding:'))
  const shell =
    siding ??
    children.find(
      (child) =>
        child.getName().endsWith(':stone-mesh') ||
        child.getName() === `building-${building.id}:wood-mesh`,
    )
  const primitive = shell?.getMesh()?.listPrimitives()[0]
  if (!(shell && primitive)) {
    throw new Error(`Missing wall shell for ${building.id}`)
  }
  return { shell, primitive, siding: Boolean(siding) }
}

export async function finishPerditionRooms(
  doc: Document,
  layout: Pick<TownLayout, 'buildings'>,
): Promise<{ floors: number; roomFaces: number; facades: number }> {
  const root = doc.getRoot()
  const totals = { floors: 0, roomFaces: 0, facades: 0 }
  if (root.getExtras()[version]) {
    return totals
  }
  const find = (name: string) =>
    root.listMaterials().find((material) => material.getName() === name)
  const originalFloor = find('Perdition floor')
  const originalWall = find('Perdition wood')
  const nodes = new Map(root.listNodes().map((node) => [node.getName(), node]))
  const decks = nodes.get('ground-Perdition')
  if (!(originalFloor && originalWall && decks)) {
    throw new Error('Missing baseline Perdition wood, floor or decks')
  }
  const [floor, plaster] = await Promise.all([
    floorSurface(doc, originalFloor),
    plasterSurface(doc),
  ])
  totals.floors += buildingFloor(decks, originalFloor, floor, {
    phase: 0,
    tint: porchTint,
    label: 'porch decking',
  })
  for (const building of layout.buildings) {
    const finish = roomFinishes[building.id]
    const node = nodes.get(`building-${building.id}`)
    if (!(finish && node)) {
      continue
    }
    const phase = Math.round(building.x * 3 + building.z * 11)
    const [floorTint, wallTint, plastered] = finish
    totals.floors += buildingFloor(node, originalFloor, floor, {
      phase,
      tint: floorTint,
      label: `${building.id} floorboards`,
    })
    const interior = finishMaterial(
      plastered ? plaster : originalWall,
      `Perdition ${building.id} inner wall`,
      wallTint,
    )
    const { shell, primitive, siding } = roomShell(node, building)
    totals.roomFaces += localWall(shell, primitive, building, interior)
    if (siding) {
      weatherSiding(primitive, phase)
      totals.facades++
    }
  }
  if (totals.floors !== Object.keys(roomFinishes).length + 1 || totals.roomFaces === 0) {
    throw new Error(`Territory finish coverage changed: ${JSON.stringify(totals)}`)
  }
  floor.dispose()
  plaster.dispose()
  root.setExtras({ ...root.getExtras(), [version]: 1 })
  return totals
}
