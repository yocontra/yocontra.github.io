/** Install the formed leather around the existing single and paired holster grips. */
import {
  type Accessor,
  type Document,
  type Material,
  NodeIO,
  type Primitive,
  type Skin,
  type vec3,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  compactPrimitive,
  copyToDocument,
  joinPrimitives,
  prune,
  unpartition,
  weld,
} from '@gltf-transform/functions'
import { Mat4, Vec3 } from 'playcanvas'
import { normalizeSkinnedAsset } from './normalize-skinned-nodes.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
type Side = 'Left' | 'Right'
interface Range {
  name: string
  start: number
  count: number
}
interface Binding {
  leg: number
  hips: number
  side: Side
  toNative: Mat4
  hanger?: boolean
}
type TintBounds = readonly [number, number][]

function hipBind(skin: Skin): Mat4 {
  const index = skin.listJoints().findIndex((node) => node.getName() === 'Hips')
  const inverses = skin.getInverseBindMatrices()
  if (!inverses || index < 0) {
    throw new Error('Missing the native holster hip bind')
  }
  const mat = new Mat4()
  mat.data.set(inverses.getElement(index, []))
  return mat
}

function point(matrix: Mat4, [x, y, z]: vec3): vec3 {
  const transformed = matrix.transformPoint(new Vec3(x, y, z))
  return [transformed.x, transformed.y, transformed.z]
}

const rangeVertices = (position: Accessor, { start, count }: Range): vec3[] =>
  Array.from({ length: count }, (_, i) => position.getElement<vec3>(start + i, [0, 0, 0]))

function matchingVertices(native: vec3[], canonical: vec3[]): number[] {
  return native.flatMap(([x, y, z], index) =>
    canonical.some(
      ([a, b, c]) =>
        Math.abs(x - a) < 0.000_28 && Math.abs(y - b) < 0.000_28 && Math.abs(z - c) < 0.000_28,
    )
      ? [index]
      : [],
  )
}

function tintBounds(uv: Accessor, vertices: number[]): TintBounds {
  const tint = vertices.map((index) => uv.getElement(index, []))
  return [0, 1].map((axis) => {
    const values = tint.map((p) => p[axis] ?? 0)
    return [Math.min(...values), Math.max(...values)]
  })
}

function attachPocket(doc: Document, part: Primitive, binding: Binding, bounds: TintBounds): void {
  const position = part.getAttribute('POSITION')
  const uv = part.getAttribute('TEXCOORD_0')
  const buffer = position?.getBuffer()
  const tint = part.getMaterial()?.getBaseColorFactor()[0] ?? 1
  if (!(position && uv && buffer)) {
    throw new Error('Missing the formed holster surface')
  }
  const count = position.getCount()
  const joints = new Uint8Array(count * 4)
  const weights = new Uint8Array(count * 4)
  const color = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const local = position.getElement<vec3>(i, [0, 0, 0])
    position.setElement(i, point(binding.toNative, local))
    uv.setElement(
      i,
      uv.getElement(i, []).map((value, axis) => {
        const [lower, upper] = bounds[axis] ?? [0, 1]
        return lower + (upper - lower) * (0.025 + Math.max(0, Math.min(1, value)) * 0.95)
      }),
    )
    // The hanger crosses from the belt to the leg. The formed pocket bends with the leg.
    const length = binding.side === 'Right' ? 0.112 : 0.069
    const share = binding.hanger
      ? Math.round(255 * Math.max(0, Math.min(1, (0.909 - local[1]) / length)))
      : 255
    joints.set([binding.leg, binding.hips, 0, 0], i * 4)
    weights.set([share, 255 - share, 0, 0], i * 4)
    color.set([tint, tint, tint, 0.5], i * 4)
  }
  part.setAttribute(
    'JOINTS_0',
    doc.createAccessor().setType('VEC4').setBuffer(buffer).setArray(joints),
  )
  part.setAttribute(
    'WEIGHTS_0',
    doc.createAccessor().setType('VEC4').setBuffer(buffer).setArray(weights).setNormalized(true),
  )
  part.setAttribute(
    'COLOR_0',
    doc.createAccessor().setType('VEC4').setBuffer(buffer).setArray(color),
  )
}

function copyPockets(
  doc: Document,
  art: Document,
  binding: Binding,
  bounds: TintBounds,
): Primitive[] {
  const parts = art
    .getRoot()
    .listNodes()
    .filter((node) => node.getName().startsWith(`${binding.side} `) && node.getMesh())
    .flatMap((node) =>
      (node.getMesh()?.listPrimitives() ?? []).map((primitive) => ({
        primitive,
        hanger: node.getName().endsWith('belt hanger'),
      })),
    )
  const copied = copyToDocument(
    doc,
    art,
    parts.map(({ primitive }) => primitive),
  )
  return parts.map(({ primitive, hanger }) => {
    const fitted = copied.get(primitive) as Primitive
    attachPocket(doc, fitted, { ...binding, hanger }, bounds)
    return fitted
  })
}

function cutReplacedPockets(primitive: Primitive, removed: Set<number>): void {
  const indices = primitive.getIndices()
  const faces = indices?.getArray()
  if (!(indices && faces)) {
    throw new Error('Missing the original belt indices')
  }
  const retained: number[] = []
  for (let i = 0; i < faces.length; i += 3) {
    const face = faces.subarray(i, i + 3)
    if (!face.every((index) => removed.has(index))) {
      retained.push(...face)
    }
  }
  if (retained.length === faces.length || retained.length === 0) {
    throw new Error('The former leather pocket did not separate from the belt')
  }
  indices.setArray(Uint16Array.from(retained))
  compactPrimitive(primitive)
}

function packPockets(parts: Primitive[], leather: Material): Primitive[] {
  const hardware = parts.filter((part) => part.getMaterial()?.getName().startsWith('Cast silver'))
  const fitted = parts.filter((part) => !hardware.includes(part))
  const merged = [joinPrimitives(fitted.map((part) => part.setMaterial(leather)))]
  const silver = hardware[0]?.getMaterial()
  if (silver) {
    merged.push(joinPrimitives(hardware.map((part) => part.setMaterial(silver))))
  }
  for (const part of parts) {
    part.dispose()
  }
  return merged
}

export async function fitHolsterPockets(
  source: string,
  rig: string,
  target: string,
): Promise<void> {
  const [art, original, native] = await Promise.all([
    io.read(source),
    io.read(rig),
    io.read(target),
  ])
  const base = original
    .getRoot()
    .listNodes()
    .find((joint) => joint.getName() === 'Character' && joint.getMesh() && joint.getSkin())
  const raw = base?.getMesh()?.listPrimitives()[0]
  const rawPosition = raw?.getAttribute('POSITION')
  const bind = base?.getSkin()
  const node = native
    .getRoot()
    .listNodes()
    .find((part) => part.getMesh() && part.getSkin())
  const mesh = node?.getMesh()
  const former = mesh?.listPrimitives()[0]
  const skin = node?.getSkin()
  const position = former?.getAttribute('POSITION')
  const uv = former?.getAttribute('TEXCOORD_0')
  const leather = former?.getMaterial()
  const ranges = (raw?.getExtras().pieceRanges as Range[] | undefined)?.filter(
    (range) => range.name === 'Gunbelt',
  )
  if (!(position && uv && leather && skin && mesh && former && rawPosition && bind && ranges)) {
    throw new Error(`Missing matching holster surfaces for ${target}`)
  }
  const toRaw = new Mat4().mul2(hipBind(bind).invert(), hipBind(skin))
  const toNative = toRaw.clone().invert()
  const points = Array.from({ length: position.getCount() }, (_, i) =>
    point(toRaw, position.getElement<vec3>(i, [0, 0, 0])),
  )
  const accents = ranges.filter((range) => [10, 20, 288, 1440].includes(range.count))
  const removed = new Set(
    matchingVertices(
      points,
      accents.flatMap((range) => rangeVertices(rawPosition, range)),
    ),
  )
  const hips = skin.listJoints().findIndex((bone) => bone.getName() === 'Hips')
  const pockets = ranges.filter((range) => range.count === 81)
  const fitted: Primitive[] = []
  for (const pocket of pockets) {
    const canonical = rangeVertices(rawPosition, pocket)
    const side = (canonical[0]?.[0] ?? 0) < 0 ? 'Right' : 'Left'
    const leg = skin.listJoints().findIndex((bone) => bone.getName() === `UpperLeg${side[0]}`)
    const vertices = matchingVertices(points, canonical)
    if (leg < 0 || hips < 0 || vertices.length < 70) {
      throw new Error(`Cannot fit the ${side.toLowerCase()} holster pocket`)
    }
    for (const index of vertices) {
      removed.add(index)
    }
    fitted.push(
      ...copyPockets(native, art, { leg, hips, side, toNative }, tintBounds(uv, vertices)),
    )
  }
  if (fitted.length === 0) {
    throw new Error('No authored holster pockets matched')
  }
  cutReplacedPockets(former, removed)
  for (const pocket of packPockets(fitted, leather)) {
    mesh.addPrimitive(pocket)
  }
  await native.transform(weld(), prune({ keepAttributes: true, keepLeaves: true }), unpartition())
  await io.write(target, native)
  await normalizeSkinnedAsset(target)
}
