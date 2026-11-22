/** Fit the linen collars, Trail Duds tie and baked player belt to the rendered rider. */
import { resolve } from 'node:path'
import { type Accessor, type Document, NodeIO, type Skin } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Mat4, Vec3 } from 'playcanvas'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
export const RIDER_GARMENT_FIT_VERSION = 1
const tolerance = 0.0016
type Position = [number, number, number]
type FitKind = 'shirt' | 'fold' | 'tie' | 'belt' | 'belt-pair'
interface FitPoint {
  position: Position
  delta: Position
  tie: boolean
}
interface Range {
  name?: string
  swatch?: string
  start: number
  count: number
}

function inverseHead(skin: Skin): Mat4 {
  const head = skin.listJoints().findIndex((joint) => joint.getName() === 'Head')
  const inverses = skin.getInverseBindMatrices()
  if (!inverses || head < 0) {
    throw new Error('Missing garment fit head binding')
  }
  const matrix = new Mat4()
  matrix.data.set(inverses.getElement(head, []))
  return matrix
}

function smooth(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

function hasTie(id: string): boolean {
  return id === 'player' || id.startsWith('outfit.trail-duds')
}

function hasBelt(id: string): boolean {
  return id === 'player' || id.startsWith('holster.')
}

function kindOf(range: Range, id: string): FitKind | undefined {
  if (range.name === 'WesternShirt') {
    return 'shirt'
  }
  if (range.name === 'ShirtTailoring') {
    return 'fold'
  }
  if (hasTie(id) && !range.name && range.swatch === 'linen' && range.count === 35) {
    return 'tie'
  }
  if (hasBelt(id) && range.name === 'Gunbelt' && (range.count === 144 || range.count === 80)) {
    return id.endsWith('.pair') ? 'belt-pair' : 'belt'
  }
  return undefined
}

function shape([x, y, z]: Position, kind: FitKind): Position | undefined {
  if (kind === 'belt' || kind === 'belt-pair') {
    // Leave the holstered gun and its lower leather shell on their original mount.
    const side =
      kind === 'belt-pair' ? 1 - smooth(0.13, 0.19, Math.abs(x)) : smooth(-0.19, -0.13, x)
    const center = 1 - smooth(0.1, 0.19, Math.abs(x))
    return [-x * (0.045 + 0.073 * side), 0, -(z + 0.077) * (0.1 + 0.15 * center)]
  }
  if (kind === 'tie') {
    // Keep the upper seam and tuck the lower points into a fold.
    const fold = 1 - smooth(1.369, 1.435, y)
    const arc = Math.max(0, 1 - ((x + 0.014) / 0.042) ** 2)
    return [-0.1 * (x + 0.014) * fold, 0.016 * fold, 0.007 * fold * arc]
  }
  if (y <= 1.39) {
    return undefined
  }
  // A lower rear rim stays inside the waistcoat and coat openings as the neck turns.
  const rear = 1 - smooth(-0.015, 0.03, z)
  const shirt = kind === 'shirt'
  const band = shirt ? smooth(1.394, 1.44, y) : smooth(1.39, 1.455, y)
  const drop = shirt ? 0.006 + 0.01 * rear : 0.014 + 0.016 * rear
  return [-0.004 * band, -drop * band, 0]
}

function shirtPoints(position: Accessor, ranges: Range[], id: string): FitPoint[] {
  const result: FitPoint[] = []
  for (const range of ranges) {
    const kind = kindOf(range, id)
    if (!kind) {
      continue
    }
    for (let index = range.start; index < range.start + range.count; index++) {
      const point = position.getElement<Position>(index, [0, 0, 0])
      const delta = shape(point, kind)
      if (delta) {
        result.push({ position: point, delta, tie: kind === 'tie' })
      }
    }
  }
  return result
}

async function scarfPoints(id: string): Promise<FitPoint[]> {
  if (!hasTie(id)) {
    return []
  }
  const authored = await io.read(resolve('tools/art/characters/neckerchiefs', `${id}.glb`))
  const band = authored.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute('POSITION')
  if (!band) {
    throw new Error(`Missing authored scarf band for ${id}`)
  }
  return Array.from({ length: band.getCount() }, (_, index) => {
    const point = band.getElement<Position>(index, [0, 0, 0])
    const [x, y, z] = point
    const fold = smooth(1.436, 1.466, y)
    return {
      position: point,
      delta: [-(x + 0.014) * 0.055 * fold, -0.007 * fold, -(z + 0.004) * 0.05 * fold],
      tie: true,
    }
  })
}

function nearest(point: Vec3, fit: FitPoint[], tie: boolean | undefined): FitPoint | undefined {
  let best: FitPoint | undefined
  let distance = tolerance * tolerance
  for (const target of fit) {
    if (tie !== undefined && tie !== target.tie) {
      continue
    }
    const [x, y, z] = target.position
    const next = (point.x - x) ** 2 + (point.y - y) ** 2 + (point.z - z) ** 2
    if (next < distance) {
      best = target
      distance = next
    }
  }
  return best
}

interface GarmentFit {
  origin: Mat4
  move: (point: Vec3, material: string) => { delta: Position; waist: boolean } | undefined
}

export async function prepareNativeRiderGarmentFit(
  id: string,
  source: Document,
): Promise<GarmentFit> {
  const carriesBelt = hasBelt(id)
  const body = source
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'Character' && node.getSkin() && node.getMesh())
  const skin = body?.getSkin()
  const position = body?.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')
  const ranges = body?.getExtras().pieceRanges as Range[] | undefined
  if (!(skin && position && ranges)) {
    throw new Error(`Missing original linen surface for ${id}`)
  }
  const fit = [...shirtPoints(position, ranges, id), ...(await scarfPoints(id))]
  return {
    origin: inverseHead(skin).invert(),
    move(point, material) {
      const neck =
        point.y >= 1.356 &&
        point.y <= 1.475 &&
        Math.abs(point.x) <= 0.13 &&
        point.z >= -0.115 &&
        point.z <= 0.08
      const waist = carriesBelt && point.y >= 0.88 && point.y <= 0.97
      if (!(neck || waist)) {
        return
      }
      const match = nearest(
        point,
        fit,
        material === 'Fabric' ? undefined : material === 'Neckerchief',
      )
      return match ? { delta: match.delta, waist } : undefined
    },
  }
}

function applyFit(positions: Accessor, toFit: Mat4, fit: GarmentFit, material: string) {
  const toNative = toFit.clone().invert()
  let count = 0
  let beltCount = 0
  for (let index = 0; index < positions.getCount(); index++) {
    const point = toFit.transformPoint(
      new Vec3(...positions.getElement<Position>(index, [0, 0, 0])),
    )
    const match = fit.move(point, material)
    if (!match) {
      continue
    }
    const result = toNative.transformPoint(point.add(new Vec3(...match.delta)))
    positions.setElement(index, [result.x, result.y, result.z])
    count++
    if (match.waist) {
      beltCount++
    }
  }
  return { count, beltCount }
}

export async function fitNativeRiderGarments(id: string, targetPath: string): Promise<number> {
  const carriesBelt = hasBelt(id)
  if (id.includes('poncho') || !(carriesBelt || id.startsWith('outfit.'))) {
    return 0
  }
  const [source, target] = await Promise.all([
    io.read(resolve('tools/art/characters', `${id}.gltf`)),
    io.read(targetPath),
  ])
  const root = target.getRoot()
  if (root.getExtras().riderGarmentFit === RIDER_GARMENT_FIT_VERSION) {
    return 0
  }
  const fit = await prepareNativeRiderGarmentFit(id, source)
  let count = 0
  let beltCount = 0
  const visited = new Set<Accessor>()
  const materials = new Set(['Fabric', 'Dyeable', 'Neckerchief'])
  for (const node of root.listNodes()) {
    const bones = node.getSkin()
    if (!bones) {
      continue
    }
    const toFit = new Mat4().mul2(fit.origin, inverseHead(bones))
    for (const part of node.getMesh()?.listPrimitives() ?? []) {
      const material = part.getMaterial()?.getName()
      const positions = part.getAttribute('POSITION')
      if (!(material && materials.has(material) && positions) || visited.has(positions)) {
        continue
      }
      visited.add(positions)
      const patch = applyFit(positions, toFit, fit, material)
      count += patch.count
      beltCount += patch.beltCount
    }
  }
  if (count < 25 || (carriesBelt && beltCount < 20)) {
    throw new Error(
      `Only ${count} matched garment vertices and ${beltCount} belt vertices for ${id}`,
    )
  }
  root.setExtras({ ...root.getExtras(), riderGarmentFit: RIDER_GARMENT_FIT_VERSION })
  await io.write(targetPath, target)
  return count
}
