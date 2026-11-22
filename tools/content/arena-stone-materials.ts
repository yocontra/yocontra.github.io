/** Encode the facade maps for the native Bank and Mission surface overlay. */
import { join } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, dequantize } from '@gltf-transform/functions'
import { applyArenaFacadeWear } from './arena-facade-wear.ts'
import { withContentOutput } from './content-output.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const directory = process.argv[2]
if (!directory) {
  throw new Error('Supply the staged directory containing mission-input.glb and bank-input.glb')
}
const names = ['mission', 'bank'] as const
await Promise.all(
  names.map(async (name) => {
    const input = await io.read(join(directory, `${name}-input.glb`))
    await input.transform(dequantize())
    await applyArenaFacadeWear(input, name)
    const maps = new Document()
    maps.createBuffer()
    for (const node of input.getRoot().listNodes()) {
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        const material = primitive.getMaterial()
        if (!(material && material.getBaseColorTexture()?.getName().startsWith('Arena '))) {
          continue
        }
        copyToDocument(maps, input, [material])
          .get(material)
          ?.setName(`${node.getName()} ${material.getName()}`)
      }
    }
    const path = join(directory, `${name}.glb`)
    await io.write(path, maps)
    await withContentOutput(join(directory, 'resources'), () => compressEnvironmentTextures(path))
    console.log(
      name,
      maps
        .getRoot()
        .listMaterials()
        .map((material) => material.getName())
        .join(' | '),
    )
  }),
)
