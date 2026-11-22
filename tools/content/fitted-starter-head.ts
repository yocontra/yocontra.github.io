/** Install the local player's new anatomical head after the native skin bake. */
import {
  type Accessor,
  type Document,
  type Material,
  NodeIO,
  type Primitive,
  type Skin,
  type vec3,
  type vec4,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { compactPrimitive, copyToDocument, prune, unpartition } from '@gltf-transform/functions'
import { Mat4, Vec3 } from 'playcanvas'
import { normalizeSkinnedAsset } from './normalize-skinned-nodes.ts'
import { OUTLAW_HEAD_FITS } from './outlaw-head-fits.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const templeCenter = -0.027
const previousEye = { eyeScale: 0.9, eyeForward: 0.1095 }

export interface HeadFit {
  lift: number
  cutoff: number
  neckStart: number
  neckRange: number
  eyeScale: number
  eyeForward: number
  keepBrows: boolean
  fittedGroom?: boolean
  keepBeard?: boolean
  measuredEyes?: boolean
  tint?: vec4
}

const starterFit: HeadFit = {
  lift: 0,
  cutoff: 1.407,
  neckStart: 1.425,
  neckRange: 0.107,
  eyeScale: 0.88,
  eyeForward: 0.108,
  keepBrows: false,
  fittedGroom: true,
}

const greenhornFit: HeadFit = {
  lift: 0.087,
  cutoff: 1.42,
  neckStart: 1.39,
  neckRange: 0.125,
  eyeScale: 0.83,
  eyeForward: 0.1081,
  keepBrows: false,
}

interface PieceRange {
  name: string
  start: number
  count: number
}

function bind(skin: Skin, joint: string): Mat4 {
  const index = skin.listJoints().findIndex((node) => node.getName() === joint)
  const inverses = skin.getInverseBindMatrices()
  if (!inverses || index < 0) {
    throw new Error(`Missing starter head bind for ${joint}`)
  }
  const mat = new Mat4()
  mat.data.set(inverses.getElement(index, []))
  return mat
}

function point(matrix: Mat4, [x, y, z]: vec3): vec3 {
  const projected = matrix.transformPoint(new Vec3(x, y, z))
  return [projected.x, projected.y, projected.z]
}

function frontSurface(primitive: Primitive): (x: number, y: number) => number | null {
  const position = primitive.getAttribute('POSITION')
  const indices = primitive.getIndices()?.getArray()
  if (!(position && indices)) {
    throw new Error('Missing the authored head surface')
  }
  const triangles = Array.from({ length: indices.length / 3 }, (_, i) => {
    const index = i * 3
    return [
      position.getElement<vec3>(indices[index] ?? -1, [0, 0, 0]),
      position.getElement<vec3>(indices[index + 1] ?? -1, [0, 0, 0]),
      position.getElement<vec3>(indices[index + 2] ?? -1, [0, 0, 0]),
    ] as const
  })
  return (x, y) => {
    let front = Number.NEGATIVE_INFINITY
    for (const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] of triangles) {
      if (
        x < Math.min(ax, bx, cx) ||
        x > Math.max(ax, bx, cx) ||
        y < Math.min(ay, by, cy) ||
        y > Math.max(ay, by, cy)
      ) {
        continue
      }
      const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
      if (Math.abs(area) < 1e-10) {
        continue
      }
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area
      const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area
      if (u >= 0 && v >= 0 && u + v <= 1) {
        front = Math.max(front, u * az + v * bz + (1 - u - v) * cz)
      }
    }
    return Number.isFinite(front) ? front : null
  }
}

function samePoint([x, y, z]: vec3, [a, b, c]: vec3): boolean {
  return Math.abs(a - x) < 0.000_28 && Math.abs(b - y) < 0.000_28 && Math.abs(c - z) < 0.000_28
}

function isNear(sample: vec3, points: readonly vec3[]): boolean {
  return points.some((other) => samePoint(sample, other))
}

function eyeFit(
  [x, y, z]: vec3,
  { eyeScale: scale, eyeForward }: Pick<HeadFit, 'eyeScale' | 'eyeForward'>,
): vec3 {
  const left = x < templeCenter
  const [centerX, centerY, centerZ]: vec3 = left
    ? [-0.0595, 1.583, 0.1136]
    : [0.0055, 1.5865, 0.1166]
  return [
    centerX + (x - centerX) * scale,
    1.584 + (y - centerY) * scale,
    eyeForward + (z - centerZ) * scale,
  ]
}

function fitMeasuredEyes(eyes: readonly vec3[], fit: HeadFit): (eye: vec3) => vec3 {
  const left = eyes.filter((eye) => eye[0] < templeCenter)
  const right = eyes.filter((eye) => eye[0] >= templeCenter)
  const center = (group: readonly vec3[]): vec3 => {
    const result: vec3 = [0, 0, 0]
    for (const [x, y, z] of group) {
      result[0] += x / group.length
      result[1] += y / group.length
      result[2] += z / group.length
    }
    return result
  }
  const a = center(left)
  const b = center(right)
  return ([x, y, z]) => {
    const t = x < templeCenter
    const [ox, oy, oz] = t ? a : b
    return [
      (t ? -0.06 : 0.006) + (x - ox) * fit.eyeScale,
      1.584 + (y - oy) * fit.eyeScale,
      fit.eyeForward + (z - oz) * fit.eyeScale,
    ]
  }
}

function trimFormerHead(
  former: Primitive,
  source: Primitive,
  toGame: Mat4,
  options: { head: Primitive; fit: HeadFit; refit: boolean; ranges: PieceRange[] },
): void {
  const { head, fit, refit, ranges } = options
  const position = former.getAttribute('POSITION')
  const canonical = source.getAttribute('POSITION')
  const indices = former.getIndices()
  const faces = indices?.getArray()
  if (!(position && canonical && indices && faces && ranges)) {
    throw new Error('Missing original starter head fittings')
  }
  const piece = (name: string) =>
    ranges
      .filter((range) => range.name === name)
      .flatMap(({ start, count }) =>
        Array.from({ length: count }, (_, i): vec3 => {
          const [x, y, z] = canonical.getElement<vec3>(start + i, [0, 0, 0])
          return [x, y + fit.lift, z]
        }),
      )
  const eyes = piece('Eye')
  const relocateEye = fit.measuredEyes
    ? fitMeasuredEyes(eyes, fit)
    : (eye: vec3) => eyeFit(eye, fit)
  const fittedEyes = refit ? eyes.map((eye) => eyeFit(eye, previousEye)) : []
  const currentEyes = refit ? eyes.map(relocateEye) : []
  const color = former.getAttribute('COLOR_0')
  const brows = piece('Brows')
  const hair = piece('Hair')
  const details = fit.keepBeard
    ? piece('Beard').filter(
        ([x, y, z]) => y >= 1.495 && y <= 1.547 && z > 0.063 && Math.abs(x - templeCenter) < 0.054,
      )
    : []
  const locate = frontSurface(head)
  const toNative = toGame.clone().invert()
  const keep = Array.from({ length: position.getCount() }, (_, index) => {
    const local = point(toGame, position.getElement(index, [0, 0, 0]))
    const newIndex = currentEyes.findIndex((eye) => samePoint(local, eye))
    const fittedIndex =
      newIndex < 0 ? fittedEyes.findIndex((eye) => samePoint(local, eye)) : newIndex
    const fittedSource = fittedIndex < 0 ? undefined : eyes[fittedIndex]
    if (fittedSource || isNear(local, eyes)) {
      position.setElement(index, point(toNative, relocateEye(fittedSource ?? local)))
      if (fit.fittedGroom && newIndex < 0 && color) {
        const texel = color.getElement<vec4>(index, [1, 1, 1, 1])
        // Keep the iris definition while toning down the old bright sclera and highlights.
        const toned = texel.slice(0, 3).map((channel) => channel * 0.7)
        color.setElement(index, [...toned, 1].slice(0, color.getElementSize()))
      }
      return true
    }
    if (isNear(local, brows)) {
      if (!fit.keepBrows) {
        return false
      }
      const [x, y, z] = local
      const across = templeCenter + (x - templeCenter) * 0.9
      const height = y + 0.003
      const forehead = locate(across, height) ?? z
      position.setElement(index, point(toNative, [across, height, forehead + 0.0009]))
      return true
    }
    if (isNear(local, details)) {
      const [x, y, z] = local
      const skinDepth = locate(x, y)
      if (skinDepth !== null) {
        position.setElement(index, point(toNative, [x, y, Math.max(z, skinDepth + 0.0016)]))
      }
      return true
    }
    return local[1] < fit.cutoff || (!fit.fittedGroom && isNear(local, hair))
  })
  const preserved: number[] = []
  for (let i = 0; i < faces.length; i += 3) {
    const triangle = faces.subarray(i, i + 3)
    if (triangle.every((index) => keep[index])) {
      preserved.push(...triangle)
    }
  }
  if (refit && preserved.length === faces.length) {
    return
  }
  if (preserved.length === 0 || preserved.length === faces.length) {
    throw new Error('The former starter head did not separate from the body')
  }
  indices.setArray(Uint16Array.from(preserved))
  compactPrimitive(former)
}

function packAttribute(accessor: Accessor, unsigned: boolean): void {
  const values = accessor.getArray()
  if (!values) {
    throw new Error('Missing authored starter head vertex data')
  }
  if (unsigned) {
    accessor.setArray(Uint16Array.from(values, (v) => Math.round(v * 65_535)))
  } else {
    if (values.some((v) => Math.abs(v) > 1)) {
      throw new Error('Starter head lies outside the native quantized bounds')
    }
    accessor.setArray(Int16Array.from(values, (v) => Math.round(v * 32_767)))
  }
  accessor.setNormalized(true)
}

function smoothWeight(start: number, end: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return t * t * (3 - 2 * t)
}

function attachSkin(
  doc: Document,
  head: Primitive,
  skin: Skin,
  { toNative, fit }: { toNative: Mat4; fit: HeadFit },
): void {
  const position = head.getAttribute('POSITION')
  const normal = head.getAttribute('NORMAL')
  const uv = head.getAttribute('TEXCOORD_0')
  const buffer = position?.getBuffer()
  const bones = skin.listJoints()
  const neckIndex = bones.findIndex((bone) => bone.getName() === 'Neck')
  const chestIndex = bones.findIndex((bone) => bone.getName() === 'Chest')
  const headIndex = bones.findIndex((bone) => bone.getName() === 'Head')
  if (
    !(position && normal && uv && buffer) ||
    neckIndex < 0 ||
    headIndex < 0 ||
    (fit.fittedGroom && chestIndex < 0)
  ) {
    throw new Error('Missing the starter head mesh or its skin')
  }
  const count = position.getCount()
  const joints = new Uint8Array(count * 4)
  const weights = new Uint8Array(count * 4)
  for (let i = 0; i < count; i++) {
    const game = position.getElement<vec3>(i, [0, 0, 0])
    const rear = fit.fittedGroom ? 1 - smoothWeight(0.006, 0.053, game[2]) : 0
    const start = fit.neckStart + 0.025 * rear
    const end = start + fit.neckRange
    const headWeight = fit.fittedGroom
      ? smoothWeight(start, end, game[1])
      : Math.max(0, Math.min(1, (game[1] - start) / (end - start)))
    const collar = fit.fittedGroom
      ? (1 - smoothWeight(1.405, 1.467, game[1])) * (0.16 + 0.12 * rear)
      : 0
    const weight = Math.round(255 * headWeight)
    const chest = Math.round((255 - weight) * collar)
    position.setElement(i, point(toNative, game))
    joints.set([headIndex, neckIndex, fit.fittedGroom ? chestIndex : 0, 0], i * 4)
    weights.set([weight, 255 - weight - chest, chest, 0], i * 4)
  }
  head.setAttribute(
    'JOINTS_0',
    doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer),
  )
  head.setAttribute(
    'WEIGHTS_0',
    doc.createAccessor().setType('VEC4').setArray(weights).setNormalized(true).setBuffer(buffer),
  )
  // The groom can extend beyond the body mesh's normalized bind interval at
  // the crown. Keep those positions floating point in the same skin space.
  if (head.getMaterial()?.getName() !== 'Tobacco brown hair') {
    packAttribute(position, false)
  }
  packAttribute(normal, false)
  packAttribute(uv, true)
}

/** Replacing a previously published fit leaves its retained rig and eye sockets in place. */
function removeFittedHead(doc: Document): boolean {
  let removed = false
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!(node.getSkin() && mesh)) {
      continue
    }
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial()?.getName()
      if (
        material &&
        ['Field-worn skin', 'Tobacco brown hair', 'Tobacco brown eyebrows'].includes(material)
      ) {
        primitive.dispose()
        removed = true
      }
    }
    if (mesh.listPrimitives().length === 0) {
      node.setMesh(null).setSkin(null)
      if (node.getName().startsWith('native.skin-part.') && node.listChildren().length === 0) {
        node.dispose()
      }
    }
  }
  return removed
}

async function installHead(
  { source, authoring, target }: { source: string; authoring: string; target: string },
  fit: HeadFit,
  palette?: string,
): Promise<void> {
  const [raw, art, native] = await Promise.all([
    io.read(source),
    io.read(authoring),
    io.read(target),
  ])
  const original = raw
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'Character' && node.getSkin() && node.getMesh())
  const originalSkin = original?.getSkin()
  const originalPart = original?.getMesh()?.listPrimitives()[0]
  const ranges = (original?.getExtras().pieceRanges ?? originalPart?.getExtras().pieceRanges) as
    | PieceRange[]
    | undefined
  const body = native
    .getRoot()
    .listNodes()
    .find(
      (node) =>
        node.getSkin() &&
        node
          .getMesh()
          ?.listPrimitives()
          .some((primitive) => primitive.getMaterial()?.getName() === 'Character'),
    )
  const nativeSkin = body?.getSkin()
  const mesh = body?.getMesh()
  const former = mesh?.listPrimitives()[0]
  const donorParts = art
    .getRoot()
    .listMeshes()
    .flatMap((part) => part.listPrimitives())
  const head =
    donorParts.length === 1
      ? donorParts[0]
      : donorParts.find((part) => part.getMaterial()?.getName().startsWith('Field-worn skin'))

  if (!(originalSkin && originalPart && ranges && nativeSkin && mesh && former && head)) {
    throw new Error(`Cannot fit starter head for ${target}`)
  }
  // Quantization moves the skin bind space. Measure its transform from the retained Head joint.
  const toGame = new Mat4().mul2(bind(originalSkin, 'Head').invert(), bind(nativeSkin, 'Head'))
  toGame.data[13] = (toGame.data[13] ?? 0) + fit.lift
  const toNative = toGame.clone().invert()
  const refit = fit.fittedGroom ? removeFittedHead(native) : false
  trimFormerHead(former, originalPart, toGame, { head, fit, refit, ranges })
  if (palette) {
    const paletteDocument = await io.read(palette)
    const skin = paletteDocument
      .getRoot()
      .listMaterials()
      .find((surface) => surface.getName() === 'Field-worn skin')
    if (!skin) {
      throw new Error('Missing authored face surface material')
    }
    const material = copyToDocument(art, paletteDocument, [skin]).get(skin) as Material
    if (fit.tint) {
      material.setBaseColorFactor(fit.tint)
    }
    head.setMaterial(material)
  }
  const fitted = copyToDocument(native, art, donorParts)
  for (const donor of donorParts) {
    const replacement = fitted.get(donor)
    if (!replacement) {
      throw new Error('Missing a copied head surface')
    }
    attachSkin(native, replacement as Primitive, nativeSkin, { toNative, fit })
    mesh.addPrimitive(replacement as Primitive)
  }
  await native.transform(prune({ keepAttributes: true, keepLeaves: true }), unpartition())
  await io.write(target, native)
  await normalizeSkinnedAsset(target)
}

export function fitStarterHead(source: string, authoring: string, target: string): Promise<void> {
  return installHead({ source, authoring, target }, starterFit)
}

export function fitGreenhornHead(
  paths: { source: string; authoring: string; target: string },
  palette: string,
): Promise<void> {
  return installHead(paths, greenhornFit, palette)
}

export function fitOutlawHead(
  paths: { source: string; authoring: string; target: string },
  opts: { id: number; palette: string },
): Promise<void> {
  const fit = OUTLAW_HEAD_FITS[opts.id]
  if (!fit) {
    throw new Error(`Missing authored cast fit ${opts.id}`)
  }
  return installHead(paths, { ...greenhornFit, ...fit }, opts.palette)
}
