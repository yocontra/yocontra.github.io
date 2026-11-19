import type { Accessor, Document } from '@gltf-transform/core'
import { KHRTextureTransform, type Transform } from '@gltf-transform/extensions'
import { getBounds } from '@gltf-transform/functions'
import { CACTUS_MATERIAL, CACTUS_MESH, cactusRequired } from './frontier-cactus-candidate.ts'

const LEGACY_MATERIAL = 'Perdition saguaro skin'
const TARGETS = [
  [29.120_980_09, 11.473_106_93],
  [86.082_602_5, 94.677_108_75],
] as const
const SEMANTICS = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'] as const
const MAX_ENVELOPE_DELTA = 0.001

/** Dress only the two retained yard saguaros. The other one-arm specimen has its own high-detail mesh. */
export function installYardCacti(doc: Document, source: Document): void {
  const root = doc.getRoot()
  const detailed = cactusRequired(root.listMaterials().find((m) => m.getName() === CACTUS_MATERIAL))
  const nodes = root.listNodes().filter((node) => {
    const mesh = node.getMesh()
    return (
      node.getName() === 'prefab.saguaro_one_arm' &&
      mesh?.getName() === CACTUS_MESH &&
      mesh.listPrimitives().every((part) => part.getMaterial()?.getName() === LEGACY_MATERIAL)
    )
  })
  const positions = nodes.map((node) => node.getWorldTranslation())
  if (
    nodes.length !== TARGETS.length ||
    TARGETS.some(
      ([x, z]) => positions.filter((p) => Math.hypot(p[0] - x, p[2] - z) < 0.0001).length !== 1,
    )
  ) {
    throw new Error('Expected the two retained Frontier yard cactus placements')
  }
  const meshes = new Set(nodes.map((node) => cactusRequired(node.getMesh())))
  if (
    root.listNodes().some((node) => {
      const mesh = node.getMesh()
      return mesh && !nodes.includes(node) && meshes.has(mesh)
    })
  ) {
    throw new Error('The yard cactus geometry is shared by another prefab')
  }

  const donor = cactusRequired(source.getRoot().listMeshes()[0]?.listPrimitives()[0])
  const donorIndices = cactusRequired(donor.getIndices())
  if (
    donorIndices.getCount() !== 6030 ||
    SEMANTICS.some((semantic) => donor.getAttribute(semantic)?.getCount() !== 1094)
  ) {
    throw new Error('Unexpected measured yard cactus mesh')
  }
  const donorMaterial = cactusRequired(donor.getMaterial())
  const image = cactusRequired(donorMaterial.getBaseColorTexture())
  const transform = cactusRequired(
    donorMaterial.getBaseColorTextureInfo()?.getExtension<Transform>('KHR_texture_transform'),
  )
  const material = detailed
    .clone()
    .setName('Cactus yard loft authored color')
    .setBaseColorTexture(
      doc
        .createTexture(image.getName())
        .setMimeType('image/png')
        .setImage(cactusRequired(image.getImage())),
    )
  const extension = doc.createExtension(KHRTextureTransform)
  cactusRequired(material.getBaseColorTextureInfo()).setExtension(
    'KHR_texture_transform',
    extension.createTransform().setScale(transform.getScale()).setOffset(transform.getOffset()),
  )

  const buffer = cactusRequired(root.listBuffers()[0])
  const copy = (accessor: Accessor) =>
    doc
      .createAccessor()
      .setBuffer(buffer)
      .setType(accessor.getType())
      .setArray(cactusRequired(accessor.getArray()).slice())
      .setNormalized(accessor.getNormalized())
  const indices = copy(donorIndices)
  const attributes = SEMANTICS.map(
    (key) => [key, copy(cactusRequired(donor.getAttribute(key)))] as const,
  )
  const oldBounds = nodes.map((node) => getBounds(node))
  const retired = new Set<Accessor>()
  for (const mesh of meshes) {
    const primitives = mesh.listPrimitives()
    if (primitives.length !== 1) {
      throw new Error('Expected one primitive per retained yard cactus asset')
    }
    const part = cactusRequired(primitives[0])
    retired.add(cactusRequired(part.getIndices()))
    for (const key of part.listSemantics()) {
      retired.add(cactusRequired(part.getAttribute(key)))
      part.setAttribute(key, null)
    }
    for (const [key, accessor] of attributes) {
      part.setAttribute(key, accessor)
    }
    part.setIndices(indices).setMaterial(material)
  }
  for (const accessor of retired) {
    if (accessor.listParents().every((parent) => parent === root)) {
      accessor.dispose()
    }
  }
  for (const [index, node] of nodes.entries()) {
    const before = cactusRequired(oldBounds[index])
    const bounds = getBounds(node)
    if (
      bounds.min.some(
        (low, axis) => Math.abs(low - cactusRequired(before.min[axis])) > MAX_ENVELOPE_DELTA,
      ) ||
      bounds.max.some(
        (high, axis) => Math.abs(high - cactusRequired(before.max[axis])) > MAX_ENVELOPE_DELTA,
      )
    ) {
      throw new Error('The measured yard cactus changed a world envelope')
    }
  }
}
