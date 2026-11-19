/** Mark fully inert flora targets, while retaining the valid glTF mesh and wind channels. */
import { resolve } from 'node:path'
import { type Document, type Mesh, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const flora = /^flora-\d+$/u

export function markFrontierInertWind(doc: Document): number {
  const root = doc.getRoot()
  const weights = new Set(
    root.listAnimations().flatMap((animation) =>
      animation.getName() === 'Wind'
        ? animation
            .listChannels()
            .filter((channel) => channel.getTargetPath() === 'weights')
            .map((channel) => channel.getTargetNode())
        : [],
    ),
  )
  const eligible = new Set<Mesh>()
  const blocked = new Set<Mesh>()
  for (const node of root.listNodes()) {
    const mesh = node.getMesh()
    if (mesh) {
      const owners = flora.test(node.getName()) && weights.has(node) ? eligible : blocked
      owners.add(mesh)
    }
  }
  let count = 0
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const { outWestInertWind: previousMarker, ...extras } = primitive.getExtras()
      if (previousMarker !== undefined) {
        primitive.setExtras(extras)
      }
      if (!eligible.has(mesh) || blocked.has(mesh)) {
        continue
      }
      const targets = primitive.listTargets()
      if (
        targets.length === 0 ||
        !targets.every((target) => {
          const semantics = target.listSemantics()
          return (
            semantics.length > 0 &&
            semantics.every((semantic) => {
              const data = target.getAttribute(semantic)?.getArray()
              return data && data.length > 0 && data.every((delta) => delta === 0)
            })
          )
        })
      ) {
        continue
      }
      primitive.setExtras({ ...extras, outWestInertWind: 1 })
      count++
    }
  }
  return count
}

if (import.meta.main) {
  const [, , input, output] = process.argv
  if (!(input && output) || resolve(input) === resolve(output)) {
    throw new Error('Usage: bun tools/content/frontier-inert-wind.ts INPUT.glb OUTPUT.glb')
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const doc = await io.read(input)
  const count = markFrontierInertWind(doc)
  if (count === 0) {
    throw new Error('No inert Frontier foliage targets were marked')
  }
  await io.write(output, doc)
  console.log(`Marked ${count} inert Frontier foliage primitives.`)
}
