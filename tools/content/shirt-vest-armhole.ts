/** Tuck the linen sleeve attachment beneath the Shirt & Vest armhole. */
import { resolve } from 'node:path'
import { type Accessor, NodeIO, type Skin } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Mat4, Vec3 } from 'playcanvas'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const ids = new Set(['outfit.shirt-vest', 'outfit.shirt-vest.pair'])
export const SHIRT_VEST_ARMHOLE_VERSION = 1
type Point = [number, number, number]
interface Range {
  start: number
  count: number
  name: string
}

interface SleevePoint {
  position: Vec3
  tuck: number
}

function inverseHead(skin: Skin): Mat4 {
  const index = skin.listJoints().findIndex((joint) => joint.getName() === 'Head')
  const bind = skin.getInverseBindMatrices()
  if (!(bind && index >= 0)) {
    throw new Error('Missing canonical Shirt & Vest bind')
  }
  const matrix = new Mat4()
  matrix.data.set(bind.getElement(index, []))
  return matrix
}

function smooth(a: number, b: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

async function sleevePoints(id: string): Promise<SleevePoint[]> {
  const doc = await io.read(resolve('tools/art/characters/coat-sleeves', `${id}.glb`))
  const primitive = doc.getRoot().listMeshes()[0]?.listPrimitives()[0]
  const positions = primitive?.getAttribute('POSITION')
  const uv = primitive?.getAttribute('TEXCOORD_0')
  const range = (primitive?.getExtras().pieceRanges as Range[] | undefined)?.find(
    (piece) => piece.name === 'WesternSleeves',
  )
  if (!(positions && uv && range)) {
    throw new Error(`Missing fitted linen sleeve for ${id}`)
  }
  const points: SleevePoint[] = []
  for (let i = range.start; i < range.start + range.count; i++) {
    const position = new Vec3(...positions.getElement<Point>(i, [0, 0, 0]))
    const [, height = 0] = uv.getElement(i, [])
    const { x, y } = position
    // Taper the armhole attachment into the visible cap without shifting the elbow or cuff.
    const proximal = smooth(0.87, 0.906, height)
    const side = 1 - smooth(0.158, 0.215, Math.abs(x))
    const torso = smooth(1.21, 1.273, y)
    const tuck = smooth(0.04, 0.92, proximal * side * torso)
    if (tuck > 0.001) {
      points.push({ position, tuck })
    }
  }
  return points
}

export async function prepareShirtVestArmholeFit(id: string) {
  if (!ids.has(id)) {
    throw new Error(`Unexpected Shirt & Vest fit ${id}`)
  }
  const points = await sleevePoints(id)
  return (center: Vec3): Point | undefined => {
    if (center.y < 1.21 || center.y > 1.416 || Math.abs(center.x) > 0.217) {
      return undefined
    }
    let best = 0
    let distance = 0.000_000_36
    for (const { position: donor, tuck } of points) {
      const next = (center.x - donor.x) ** 2 + (center.y - donor.y) ** 2 + (center.z - donor.z) ** 2
      if (next < distance) {
        best = tuck
        distance = next
      }
    }
    return best > 0 ? [-Math.sign(center.x) * 0.025 * best, 0, -0.006 * best] : undefined
  }
}

function fitSurface(
  position: Accessor,
  toSource: Mat4,
  move: (point: Vec3) => Point | undefined,
): number {
  const toNative = toSource.clone().invert()
  let count = 0
  for (let i = 0; i < position.getCount(); i++) {
    const center = toSource.transformPoint(new Vec3(...position.getElement<Point>(i, [0, 0, 0])))
    const delta = move(center)
    if (!delta) {
      continue
    }
    const native = toNative.transformPoint(
      new Vec3(center.x + delta[0], center.y, center.z + delta[2]),
    )
    position.setElement(i, [native.x, native.y, native.z])
    count++
  }
  return count
}

export async function fitShirtVestArmhole(id: string, path: string): Promise<number> {
  if (!ids.has(id)) {
    return 0
  }
  const target = await io.read(path)
  const root = target.getRoot()
  if (root.getExtras().shirtVestArmhole === SHIRT_VEST_ARMHOLE_VERSION) {
    return 0
  }
  const source = await io.read(resolve('tools/art/characters', `${id}.gltf`))
  const body = source
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'Character' && node.getSkin() && node.getMesh())
  const canonical = body?.getSkin()
  if (!canonical) {
    throw new Error(`Missing canonical skin for ${id}`)
  }
  const origin = inverseHead(canonical).invert()
  const move = await prepareShirtVestArmholeFit(id)
  const visited = new Set<Accessor>()
  let count = 0
  for (const node of root.listNodes()) {
    const skin = node.getSkin()
    if (!skin) {
      continue
    }
    const toSource = new Mat4().mul2(origin, inverseHead(skin))
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION')
      if (primitive.getMaterial()?.getName() === 'Dyeable' && position && !visited.has(position)) {
        visited.add(position)
        count += fitSurface(position, toSource, move)
      }
    }
  }
  if (count < 250 || count > 1500) {
    throw new Error(`Unexpected Shirt & Vest armhole coverage: ${count}`)
  }
  root.setExtras({ ...root.getExtras(), shirtVestArmhole: SHIRT_VEST_ARMHOLE_VERSION })
  await io.write(path, target)
  return count
}

if (import.meta.main) {
  const [id, path] = process.argv.slice(2)
  if (!(id && path && ids.has(id))) {
    throw new Error('Usage: bun tools/content/shirt-vest-armhole.ts OUTFIT INPUT_COPY.glb')
  }
  console.log(`${id}: ${await fitShirtVestArmhole(id, path)} sleeve vertices`)
}
