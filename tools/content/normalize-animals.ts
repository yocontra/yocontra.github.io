/** Normalize imported CC0 animals to the authored western scene's metre scale. */
import { getBounds, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
for (const [name, height] of [
  ['dog', 0.65],
  ['horse', 2.25],
] as const) {
  const path = `public/experiments/out-west/3d/dynamic/${name}.glb`
  const doc = await io.read(path)
  const scene = doc.getRoot().listScenes()[0]
  if (!scene) {
    throw new Error(`Missing ${name} scene`)
  }
  const { min, max } = getBounds(scene)
  const k = height / (max[1] - min[1])
  const root = doc
    .createNode('Animal')
    .setScale([k, k, k])
    .setTranslation([0, -min[1] * k, 0])
  for (const child of scene.listChildren()) {
    scene.removeChild(child)
    root.addChild(child)
  }
  scene.addChild(root)
  await io.write(path, doc)
}
