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

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const templeCenter = -0.027

interface HeadFit {
  lift: number
  cutoff: number
  neckStart: number
  neckRange: number
  eyeScale: number
  eyeForward: number
  keepBrows: boolean
  keepBeard?: boolean
  measuredEyes?: boolean
  tint?: vec4
}

const starterFit: HeadFit = {
  lift: 0,
  cutoff: 1.435,
  neckStart: 1.425,
  neckRange: 0.09,
  eyeScale: 0.9,
  eyeForward: 0.1095,
  keepBrows: true,
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

function isNear([x, y, z]: vec3, points: readonly vec3[]): boolean {
  return points.some(
    ([a, b, c]) =>
      Math.abs(a - x) < 0.000_28 && Math.abs(b - y) < 0.000_28 && Math.abs(c - z) < 0.000_28,
  )
}

function eyeFit([x, y, z]: vec3, { eyeScale: scale, eyeForward }: HeadFit): vec3 {
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
  options: { head: Primitive; fit: HeadFit },
): void {
  const { head, fit } = options
  const position = former.getAttribute('POSITION')
  const canonical = source.getAttribute('POSITION')
  const indices = former.getIndices()
  const faces = indices?.getArray()
  const ranges = source.getExtras().pieceRanges as PieceRange[] | undefined
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
    if (isNear(local, eyes)) {
      position.setElement(index, point(toNative, relocateEye(local)))
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
    return local[1] < fit.cutoff || isNear(local, hair)
  })
  const preserved: number[] = []
  for (let i = 0; i < faces.length; i += 3) {
    const triangle = faces.subarray(i, i + 3)
    if (triangle.every((index) => keep[index])) {
      preserved.push(...triangle)
    }
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
  const headIndex = bones.findIndex((bone) => bone.getName() === 'Head')
  if (!(position && normal && uv && buffer) || neckIndex < 0 || headIndex < 0) {
    throw new Error('Missing the starter head mesh or its skin')
  }
  const count = position.getCount()
  const joints = new Uint8Array(count * 4)
  const weights = new Uint8Array(count * 4)
  for (let i = 0; i < count; i++) {
    const game = position.getElement<vec3>(i, [0, 0, 0])
    const weight = Math.round(
      255 * Math.max(0, Math.min(1, (game[1] - fit.neckStart) / fit.neckRange)),
    )
    position.setElement(i, point(toNative, game))
    joints.set([headIndex, neckIndex, 0, 0], i * 4)
    weights.set([weight, 255 - weight, 0, 0], i * 4)
  }
  head.setAttribute(
    'JOINTS_0',
    doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer),
  )
  head.setAttribute(
    'WEIGHTS_0',
    doc.createAccessor().setType('VEC4').setArray(weights).setNormalized(true).setBuffer(buffer),
  )
  packAttribute(position, false)
  packAttribute(normal, false)
  packAttribute(uv, true)
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
  const head = art.getRoot().listMeshes()[0]?.listPrimitives()[0]
  if (!(originalSkin && originalPart && nativeSkin && mesh && former && head)) {
    throw new Error(`Cannot fit starter head for ${target}`)
  }
  // Quantization moves the skin bind space. Measure its transform from the retained Head joint.
  const toGame = new Mat4().mul2(bind(originalSkin, 'Head').invert(), bind(nativeSkin, 'Head'))
  toGame.data[13] = (toGame.data[13] ?? 0) + fit.lift
  const toNative = toGame.clone().invert()
  trimFormerHead(former, originalPart, toGame, { head, fit })
  if (palette) {
    const paletteDocument = await io.read(palette)
    const skin = paletteDocument.getRoot().listMaterials()[0]
    if (!skin) {
      throw new Error('Missing authored face surface material')
    }
    const material = copyToDocument(art, paletteDocument, [skin]).get(skin) as Material
    if (fit.tint) {
      material.setBaseColorFactor(fit.tint)
    }
    head.setMaterial(material)
  }
  const replacement = copyToDocument(native, art, [head]).get(head) as Primitive
  attachSkin(native, replacement, nativeSkin, { toNative, fit })
  mesh.addPrimitive(replacement)
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

const outlawFits: Partial<Record<number, HeadFit>> = {
  7: {
    ...greenhornFit,
    lift: -0.1911,
    eyeScale: 0.95,
    eyeForward: 0.1058,
    measuredEyes: true,
    keepBrows: true,
    keepBeard: false,
    tint: [0.86, 0.76, 0.63, 1],
  },
  11: {
    ...greenhornFit,
    lift: 0.1955,
    eyeScale: 0.822,
    eyeForward: 0.1058,
    measuredEyes: true,
    keepBrows: true,
    keepBeard: true,
    tint: [0.95, 0.86, 0.77, 1],
  },
  12: {
    ...greenhornFit,
    lift: -0.2134,
    eyeScale: 0.97,
    eyeForward: 0.1058,
    measuredEyes: true,
    keepBrows: true,
    keepBeard: true,
    tint: [0.95, 0.78, 0.68, 1],
  },
  14: {
    ...greenhornFit,
    lift: -0.1417,
    eyeScale: 0.956,
    eyeForward: 0.1058,
    measuredEyes: true,
    keepBrows: true,
    keepBeard: true,
    tint: [0.97, 0.85, 0.79, 1],
  },
  8: {
    ...greenhornFit,
    lift: 0.0434,
    eyeScale: 0.9,
    eyeForward: 0.1101,
    keepBrows: true,
    tint: [0.99, 0.89, 0.85, 1],
  },
  10: {
    ...greenhornFit,
    lift: 0.0914,
    eyeScale: 0.88,
    eyeForward: 0.108,
    keepBrows: true,
    tint: [0.97, 0.8, 0.69, 1],
  },
  4: {
    ...greenhornFit,
    lift: -0.0008,
    eyeScale: 0.892,
    eyeForward: 0.1058,
    measuredEyes: true,
    keepBrows: true,
    keepBeard: true,
    tint: [1, 0.92, 0.89, 1],
  },
  13: {
    ...greenhornFit,
    lift: -0.0136,
    eyeScale: 0.885,
    eyeForward: 0.1058,
    measuredEyes: true,
    keepBrows: true,
    keepBeard: false,
    tint: [0.89, 0.79, 0.64, 1],
  },
  1: {
    ...greenhornFit,
    lift: 0.1174,
    eyeScale: 0.87,
    eyeForward: 0.1095,
    keepBrows: true,
    keepBeard: true,
    tint: [0.96, 0.82, 0.74, 1],
  },
  3: {
    ...greenhornFit,
    lift: 0.1217,
    eyeScale: 0.88,
    eyeForward: 0.1092,
    keepBrows: true,
    tint: [0.98, 0.85, 0.78, 1],
  },
}
export function fitOutlawHead(
  paths: { source: string; authoring: string; target: string },
  opts: { id: number; palette: string },
): Promise<void> {
  const fit = outlawFits[opts.id]
  if (!fit) {
    throw new Error(`Missing authored cast fit ${opts.id}`)
  }
  return installHead(paths, fit, opts.palette)
}
