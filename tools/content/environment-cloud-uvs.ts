/** Native cloud UV authoring; freight uses the material-local world-position shader chunk. */
import type { Document, Material, Mesh, Node, Primitive } from '@gltf-transform/core'

export function authorEnvironmentCloudUvs(document: Document, name: string): void {
  // A second native UV channel keeps moving cloud shade continuous across separate buildings.
  for (const node of document.getRoot().listNodes()) {
    const original = node.getMesh()
    if (original && name === 'frontier') {
      if (preserveFreightUvs(original)) {
        continue
      }
      const unique = document.createMesh(original.getName()).setWeights(original.getWeights())
      for (const primitive of original.listPrimitives()) {
        unique.addPrimitive(primitive.clone())
      }
      node.setMesh(unique)
    }
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      authorPrimitiveCloudUvs(document, node, primitive, name)
    }
  }
}

function preserveFreightUvs(mesh: Mesh): boolean {
  const primitives = mesh.listPrimitives()
  if (primitives.length === 0 || !primitives.every((p) => isFreightMaterial(p.getMaterial()))) {
    return false
  }
  if (primitives.some((p) => !p.getAttribute('TEXCOORD_1'))) {
    throw new Error('Freight shared meshes require authored UV1 for the native cloud shader')
  }
  return true
}
function authorPrimitiveCloudUvs(
  document: Document,
  node: Node,
  primitive: Primitive,
  name: string,
): void {
  const matrix = node.getWorldMatrix()
  const position = primitive.getAttribute('POSITION')
  if (!position) {
    return
  }
  const values = new Float32Array(position.getCount() * 2)
  for (let i = 0; i < position.getCount(); i++) {
    const [x = 0, y = 0, z = 0] = position.getElement(i, [])
    const wx =
      (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0)
    const wz =
      (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0)
    if (name === 'duel' && node.getName().startsWith('ground-')) {
      values[i * 2] = (wx + 16) / 32
      values[i * 2 + 1] = (wz + 70) / 128
    } else {
      values[i * 2] = wx / 1024
      values[i * 2 + 1] = wz / 1024
    }
  }
  primitive.setAttribute(
    'TEXCOORD_1',
    document.createAccessor().setType('VEC2').setArray(values).setBuffer(position.getBuffer()),
  )
}

const PREVIOUS_AO_UV = 'freight_ao_uv'
function isFreightMaterial(material: Material | null): boolean {
  return material?.getExtras().freightWorldUv1 === true
}
/** Temporary staged glTF usage keeps UV1 alive through stock flatten/prune/weld transforms. */
export function retainFreightUv1(document: Document): void {
  for (const mesh of document.getRoot().listMeshes()) {
    preserveFreightUvs(mesh)
  }
  for (const material of document.getRoot().listMaterials().filter(isFreightMaterial)) {
    const info = material.getOcclusionTextureInfo()
    const extras = material.getExtras()
    if (info?.getTexCoord() !== 0 || PREVIOUS_AO_UV in extras) {
      throw new Error('Freight staged UV retention requires original AO UV0 and no pending marker')
    }
    material.setExtras({ ...extras, [PREVIOUS_AO_UV]: info.getTexCoord() })
    info.setTexCoord(1)
  }
}
/** Restore exactly the original map usage before final native authoring/output. */
export function restoreFreightUv1Usage(document: Document): void {
  for (const material of document.getRoot().listMaterials().filter(isFreightMaterial)) {
    const extras = { ...material.getExtras() }
    const previous = extras[PREVIOUS_AO_UV]
    const info = material.getOcclusionTextureInfo()
    if (previous !== 0 || !info) {
      throw new Error('Missing staged freight UV retention marker')
    }
    info.setTexCoord(previous)
    delete extras[PREVIOUS_AO_UV]
    material.setExtras(extras)
    const maps = [
      material.getBaseColorTextureInfo(),
      material.getNormalTextureInfo(),
      material.getMetallicRoughnessTextureInfo(),
      material.getOcclusionTextureInfo(),
    ]
    if (maps.some((map) => map && map.getTexCoord() !== 0)) {
      throw new Error('Final freight PBR maps must use authored UV0')
    }
  }
}
