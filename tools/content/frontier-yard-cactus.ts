import type { Accessor, Document } from '@gltf-transform/core'
import { KHRTextureTransform, type Transform } from '@gltf-transform/extensions'
import { getBounds } from '@gltf-transform/functions'
import { CACTUS_MATERIAL, cactusRequired } from './frontier-cactus-candidate.ts'

const LEGACY_MATERIAL = 'Perdition saguaro skin'
const NEAR_SAGUAROS = [
  {
    mesh: 'cactus.saguaro_one_arm',
    node: 'prefab.saguaro_one_arm',
    material: 'Cactus yard loft authored color',
    places: [
      [29.120_980_09, 11.473_106_93],
      [86.082_602_5, 94.677_108_75],
    ],
    vertices: 1094,
    triangles: 2010,
  },
  {
    mesh: 'cactus.saguaro_two_arm',
    node: 'prefab.saguaro_two_arm',
    material: 'Cactus yard two-arm authored color',
    places: [
      [5.562_165_03, 11.597_883_13],
      [61.558_285_2, 11.516_730_96],
      [88.070_056_59, 22.519_996_72],
    ],
    vertices: 1616,
    triangles: 2880,
  },
] as const
const SEMANTICS = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'] as const
const MAX_ENVELOPE_DELTA = 0.001

/** Dress the two one-arm and three two-arm yard specimens with their measured lofts. */
export function installYardCacti(doc: Document, oneArm: Document, twoArm?: Document): void {
  installLoft(doc, oneArm, NEAR_SAGUAROS[0])
  if (twoArm) {
    installLoft(doc, twoArm, NEAR_SAGUAROS[1])
  }
}

function installLoft(
  doc: Document,
  source: Document,
  profile: (typeof NEAR_SAGUAROS)[number],
): void {
  const root = doc.getRoot()
  const detailed = cactusRequired(root.listMaterials().find((m) => m.getName() === CACTUS_MATERIAL))
  const nodes = root.listNodes().filter((node) => {
    const mesh = node.getMesh()
    return (
      node.getName() === profile.node &&
      mesh?.getName() === profile.mesh &&
      mesh.listPrimitives().every((part) => part.getMaterial()?.getName() === LEGACY_MATERIAL)
    )
  })
  const positions = nodes.map((node) => node.getWorldTranslation())
  if (
    nodes.length !== profile.places.length ||
    profile.places.some(
      ([x, z]) => positions.filter((p) => Math.hypot(p[0] - x, p[2] - z) < 0.0001).length !== 1,
    )
  ) {
    throw new Error(`Unexpected Frontier yard cactus placements for ${profile.node}`)
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

  const donor = cactusRequired(
    source
      .getRoot()
      .listMeshes()
      .find((mesh) => mesh.getName() === profile.mesh)
      ?.listPrimitives()[0],
  )
  const donorIndices = cactusRequired(donor.getIndices())
  if (
    donorIndices.getCount() !== profile.triangles * 3 ||
    SEMANTICS.some((semantic) => donor.getAttribute(semantic)?.getCount() !== profile.vertices)
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
    .setName(profile.material)
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
