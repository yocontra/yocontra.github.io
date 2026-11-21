/** Fit authored accessories in the original rig's bind space and retain their native dye maps. */
import { type Document, NodeIO, type Primitive, type Skin, type vec3 } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, joinPrimitives, prune, unpartition, weld } from '@gltf-transform/functions'
import { Mat4, Vec3 } from 'playcanvas'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
type Binding = 'badge' | 'bandana' | 'hair'

function hipBind(skin: Skin): Mat4 {
  const hips = skin.listJoints().findIndex((joint) => joint.getName() === 'Hips')
  const inverses = skin.getInverseBindMatrices()
  if (hips < 0 || !inverses) {
    throw new Error('Missing original accessory hip bind')
  }
  return new Mat4().set(inverses.getElement(hips, []))
}

interface Fit {
  authored: Mat4
  toNative: Mat4
  bones: [number, number]
  binding: Binding
  bounds: { min: number[]; max: number[] }
}

function fitPart(doc: Document, part: Primitive, fit: Fit): void {
  const { authored, toNative, bones, binding, bounds } = fit
  const position = part.getAttribute('POSITION')
  const normal = part.getAttribute('NORMAL')
  const uv = part.getAttribute('TEXCOORD_0')
  const buffer = position?.getBuffer()
  if (!(position && normal && uv && buffer)) {
    throw new Error('Accessory artwork lacks positions, normals, or UVs')
  }
  const rgb = part.getMaterial()?.getBaseColorFactor().slice(0, 3) ?? [1, 1, 1]
  const count = position.getCount()
  const joints = new Uint8Array(count * 4)
  const weights = new Uint8Array(count * 4)
  const color = new Float32Array(count * 3)
  const transform = new Mat4().mul2(toNative, authored)
  for (let i = 0; i < count; i++) {
    const coordinate = new Vec3(...position.getElement<vec3>(i, [0, 0, 0]))
    const raw = authored.transformPoint(coordinate)
    position.setElement(i, toNative.transformPoint(raw).toArray())
    normal.setElement(
      i,
      transform
        .transformVector(new Vec3(...normal.getElement<vec3>(i, [0, 0, 0])))
        .normalize()
        .toArray(),
    )
    uv.setElement(
      i,
      uv.getElement(i, []).map((value, axis) => {
        const low = bounds.min[axis] ?? 0
        const high = bounds.max[axis] ?? 1
        return low + (high - low) * (0.04 + 0.92 * value)
      }),
    )
    const share =
      binding === 'bandana' ? Math.round(255 * Math.max(0, Math.min(1, (raw.y - 1.42) / 0.045))) : 0
    joints.set([bones[0], share ? bones[1] : 0, 0, 0], i * 4)
    weights.set([255 - share, share, 0, 0], i * 4)
    color.set(rgb, i * 3)
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
    doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(color),
  )
}

export async function fitAccessory(
  artwork: string,
  original: string,
  output: string,
  binding: Binding,
): Promise<void> {
  const [art, rig, doc] = await Promise.all([io.read(artwork), io.read(original), io.read(output)])
  const originalSkin = rig
    .getRoot()
    .listNodes()
    .find((candidate) => candidate.getMesh() && candidate.getSkin())
    ?.getSkin()
  const node = doc
    .getRoot()
    .listNodes()
    .find((part) => part.getMesh() && part.getSkin())
  const skin = node?.getSkin()
  const mesh = node?.getMesh()
  const former = mesh?.listPrimitives()[0]
  const material = former?.getMaterial()
  const uv = former?.getAttribute('TEXCOORD_0')
  if (
    !(originalSkin && skin && mesh && former && material && uv) ||
    mesh.listPrimitives().length !== 1
  ) {
    throw new Error(`Expected a single skinned accessory in ${output}`)
  }
  const primary = binding === 'hair' ? 'Head' : 'Chest'
  const bones: [number, number] = [primary, binding === 'bandana' ? 'Neck' : primary].map((joint) =>
    skin.listJoints().findIndex((bone) => bone.getName() === joint),
  ) as [number, number]
  if (bones.some((index) => index < 0)) {
    throw new Error(`Missing fitting joint in ${output}`)
  }
  const toNative = new Mat4().mul2(hipBind(skin).invert(), hipBind(originalSkin))
  const bounds = { min: uv.getMinNormalized([]), max: uv.getMaxNormalized([]) }
  const parts = art
    .getRoot()
    .listNodes()
    .flatMap((part) =>
      (part.getMesh()?.listPrimitives() ?? []).map((primitive) => ({
        part,
        primitive,
      })),
    )
  const copied = copyToDocument(
    doc,
    art,
    parts.map(({ primitive }) => primitive),
  )
  const fitted = parts.map(({ part, primitive }) => {
    const pending = copied.get(primitive) as Primitive
    fitPart(doc, pending, {
      authored: new Mat4().set(part.getWorldMatrix()),
      toNative,
      bones,
      binding,
      bounds,
    })
    return pending.setMaterial(material)
  })
  mesh.addPrimitive(joinPrimitives(fitted))
  former.dispose()
  for (const part of fitted) {
    part.dispose()
  }
  await doc.transform(weld(), prune({ keepAttributes: true, keepLeaves: true }), unpartition())
  await io.write(output, doc)
}
