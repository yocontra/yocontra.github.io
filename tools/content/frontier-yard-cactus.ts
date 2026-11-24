import { join } from 'node:path'
import type { Accessor, Document, Material, NodeIO } from '@gltf-transform/core'
import { KHRTextureTransform, type Transform } from '@gltf-transform/extensions'
import { getBounds } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import { CACTUS_MATERIAL, cactusRequired } from './frontier-cactus-candidate.ts'
import { cactusEnvelopeError } from './frontier-cactus-envelope.ts'

const LEGACY_MATERIAL = 'Perdition saguaro skin'
const NEAR_SAGUAROS = [
  {
    mesh: 'cactus.saguaro_one_arm',
    node: 'prefab.saguaro_one_arm',
    material: 'Cactus yard loft authored color',
    places: [
      [29, 11.5],
      [86.05, 94.55],
    ],
    vertices: 1094,
    triangles: 2010,
  },
  {
    mesh: 'cactus.saguaro_two_arm',
    node: 'prefab.saguaro_two_arm',
    material: 'Cactus yard two-arm authored color',
    places: [
      [5.6, 11.6],
      [61.55, 11.55],
      [88.05, 22.55],
    ],
    vertices: 1616,
    triangles: 2880,
  },
] as const
const SEMANTICS = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'] as const
const MAX_ENVELOPE_DELTA = 0.001

/** Dress the two one-arm and three two-arm yard specimens with their measured lofts. */
export async function installYardCacti(
  doc: Document,
  io: NodeIO,
  yard: string,
  highYard: boolean,
): Promise<void> {
  const twoArm = await io.read(
    join(yard, `frontier-yard-two-arm-${highYard ? 'loft' : 'legacy'}.glb`),
  )
  const oneArm = await io.read(join(yard, 'frontier-yard-loft.glb'))
  installLoft(doc, oneArm, NEAR_SAGUAROS[0])
  installLoft(doc, twoArm, NEAR_SAGUAROS[1], !highYard)
}

function installLoft(
  doc: Document,
  source: Document,
  profile: (typeof NEAR_SAGUAROS)[number],
  keepLegacyMaterial = false,
): void {
  const root = doc.getRoot()
  const nodes = root.listNodes().filter((node) => {
    const mesh = node.getMesh()
    return (
      node.getName() === profile.node &&
      mesh?.getName() === profile.mesh &&
      mesh.listPrimitives().every((part) => part.getMaterial()?.getName() === LEGACY_MATERIAL)
    )
  })
  // The instance is centered on its planted bed. The mesh pivot varies with arm girth and yaw.
  const positions = nodes.map((node) => {
    const instance = node.getParentNode()?.getParentNode()
    if (instance?.getName() !== `${profile.node.slice('prefab.'.length)}-instance`) {
      throw new Error(`Missing planted instance for ${profile.node}`)
    }
    return instance.getWorldTranslation()
  })
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
  const material = keepLegacyMaterial
    ? undefined
    : authorMaterial(doc, cactusRequired(donor.getMaterial()), profile.material)

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
  tintYardStems(cactusRequired(attributes[0])[1], cactusRequired(attributes[3])[1])
  // Compare in the donor frame. Rotating a fuller rib or a rounded crown can move a
  // world AABB corner even when the source envelope and planting matrix are identical.
  const probe = doc.createNode()
  const oldBounds = new Map([...meshes].map((mesh) => [mesh, getBounds(probe.setMesh(mesh))]))
  const oldMatrices = nodes.map((node) => node.getWorldMatrix())
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
    part.setIndices(indices)
    if (material) {
      part.setMaterial(material)
    }
  }
  for (const accessor of retired) {
    if (accessor.listParents().every((parent) => parent === root)) {
      accessor.dispose()
    }
  }
  for (const [mesh, before] of oldBounds) {
    const bounds = getBounds(probe.setMesh(mesh))
    if (cactusEnvelopeError(before, bounds) > MAX_ENVELOPE_DELTA) {
      throw new Error('The measured yard cactus changed its donor envelope')
    }
  }
  probe.dispose()
  if (nodes.some((node, i) => node.getWorldMatrix().some((v, j) => v !== oldMatrices[i]?.[j]))) {
    throw new Error('The measured yard cactus moved from its planting matrix')
  }
}

/** Dry cork near the soil and faint sun exposure over each older rib. */
function tintYardStems(position: Accessor, color: Accessor): void {
  const floor = position.getMin([])[1] ?? 0
  const height = (position.getMax([])[1] ?? 0) - floor
  const cooler = [0.97, 0.74, 0.47]
  for (let index = 0; index < position.getCount(); index++) {
    const [x = 0, y = 0, z = 0] = position.getElement(index, [] as number[])
    const radius = Math.hypot(x, z)
    const angle = Math.atan2(z, x)
    const heightRatio = (y - floor) / height
    const edge =
      0.19 + 0.06 * Math.sin(angle * 3 + radius * 13) + 0.025 * Math.sin(angle * 13 + y * 23)
    const t = Math.max(0, Math.min(1, (edge - heightRatio) / 0.17))
    const cork = t * t * (3 - 2 * t)
    const sun = 0.95 + 0.038 * Math.cos(angle + 1.1) + 0.012 * Math.sin(angle * 9 + y * 7)
    const values = color.getElement(index, [] as number[])
    for (let channel = 0; channel < 3; channel++) {
      const value = values[channel] ?? 1
      values[channel] = value * sun * (1 - cork * (1 - (cooler[channel] ?? 1)))
    }
    color.setElement(index, values)
  }
}

function authorMaterial(doc: Document, donorMaterial: Material, name: string): Material {
  const detailed = cactusRequired(
    doc
      .getRoot()
      .listMaterials()
      .find((m) => m.getName() === CACTUS_MATERIAL),
  )
  const image = cactusRequired(donorMaterial.getBaseColorTexture())
  const transform = cactusRequired(
    donorMaterial.getBaseColorTextureInfo()?.getExtension<Transform>('KHR_texture_transform'),
  )
  const material = detailed
    .clone()
    .setName(name)
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
  return material
}

/** Order the final packed Low triangles for vertex reuse after welding has assigned vertex IDs. */
export async function orderLowYardCactusIndices(doc: Document): Promise<void> {
  const profile = NEAR_SAGUAROS[1]
  const targets = doc
    .getRoot()
    .listNodes()
    .flatMap((node) => {
      if (node.getName() !== profile.node) {
        return []
      }
      return (node.getMesh()?.listPrimitives() ?? []).filter(
        (part) =>
          part.getMaterial()?.getName() === LEGACY_MATERIAL &&
          part.getAttribute('POSITION')?.getCount() === profile.vertices &&
          part.getIndices()?.getCount() === profile.triangles * 3,
      )
    })
  if (targets.length === 0) {
    return
  }
  const indices = new Set(targets.map((part) => cactusRequired(part.getIndices())))
  if (targets.length !== profile.places.length || indices.size !== 1) {
    throw new Error('Expected one packed index stream for the three Low yard cacti')
  }
  await MeshoptEncoder.ready
  const accessor = cactusRequired([...indices][0])
  const source = cactusRequired(accessor.getArray())
  if (!(source instanceof Uint16Array)) {
    throw new Error('Expected unsigned 16-bit yard cactus indices')
  }
  const ordered = Uint32Array.from(source)
  const [remap, used] = MeshoptEncoder.reorderMesh(ordered, true, false)
  const original = new Uint16Array(used)
  for (const [index, position] of remap.entries()) {
    if (position < used) {
      original[position] = index
    }
  }
  accessor.setArray(Uint16Array.from(ordered, (index) => cactusRequired(original[index])))
}
