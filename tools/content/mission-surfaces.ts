/** Replace the mission's dirt-textured adobe with an actual CC0 earth-plaster scan. */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Accessor, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import { scanMaterial } from './frontier-surfaces.ts'

const input = process.argv[2] ?? 'tools/art/environments/mission.glb'
const output = process.argv[3] ?? '/tmp/out-west-adobe-staged/mission.glb'
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const document = await io.read(input)
const adobe = document
  .getRoot()
  .listMaterials()
  .find((material) => material.getName() === 'Adobe')
if (!adobe) {
  throw new Error('Missing authored Adobe material')
}
const scan = await scanMaterial(document, 'Earth plaster source', 'clay_plaster', {
  size: 2048,
  albedoMean: null,
})
adobe
  .setBaseColorTexture(scan.getBaseColorTexture())
  .setNormalTexture(scan.getNormalTexture())
  .setMetallicRoughnessTexture(scan.getMetallicRoughnessTexture())
  .setOcclusionTexture(scan.getOcclusionTexture())
  .setMetallicFactor(0)
  .setRoughnessFactor(1)
  .setNormalScale(0.65)
// Existing UVs repeat every 3.2 m; the scan covers 2 m. Clone shared accessors
// so the physical scale correction cannot alter another material's mapping.
const scaled = new Map<Accessor, Accessor>()
const previousScale = adobe.getExtras().earthPlasterRepeatMeters ?? 3.2
if (typeof previousScale !== 'number' || previousScale <= 0) {
  throw new Error('Invalid authored earth-plaster repeat scale')
}
for (const mesh of document.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    if (primitive.getMaterial() !== adobe) {
      continue
    }
    const source = primitive.getAttribute('TEXCOORD_0')
    if (!source) {
      throw new Error('Adobe primitive has no authored UVs')
    }
    let uv = scaled.get(source)
    if (!uv) {
      const values = source.getArray()
      if (!values) {
        throw new Error('Adobe UV accessor has no data')
      }
      uv = source
        .clone()
        .setArray(Float32Array.from(values, (value) => value * (previousScale / 2)))
      scaled.set(source, uv)
    }
    primitive.setAttribute('TEXCOORD_0', uv)
  }
}
adobe.setExtras({ ...adobe.getExtras(), earthPlasterRepeatMeters: 2 })
// Preserve architecture, collision geometry and per-building tint.
scan.dispose()
await document.transform(prune())
await mkdir(dirname(output), { recursive: true })
await io.write(output, document)
console.log(`Authored earth plaster: ${output}`)
