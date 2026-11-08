/** Author independently addressable panes once; the runtime toggles native entities. */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { buildGrid, TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'

const path = 'public/experiments/out-west/3d/native-v2/baked/frontier.glb'
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const document = await io.read(path)
const root = document.getRoot()
const town = root.listNodes().find((node) => node.getName() === 'town')
if (!town) {
  throw new Error('Missing authored town')
}
for (const node of root.listNodes()) {
  if (node.getName().startsWith('glass-')) {
    node.dispose()
  }
}
const panes = buildGrid(TOWN).glass
// Remove opaque old facade faces at real openings; each new pane can disappear independently.
const facade = root
  .listNodes()
  .find((node) => node.getName() === 'windows' || node.getName().startsWith('windows-'))
const primitive = facade?.getMesh()?.listPrimitives()[0]
const position = primitive?.getAttribute('POSITION')
const oldIndices = primitive?.getIndices()
if (facade && primitive && position && oldIndices) {
  const matrix = facade.getWorldMatrix()
  const kept: number[] = []
  for (let index = 0; index < oldIndices.getCount(); index += 3) {
    const triangle = [0, 1, 2].map((offset) => {
      const value = position.getElement(oldIndices.getScalar(index + offset), [])
      const x = value[0] ?? 0
      const y = value[1] ?? 0
      const z = value[2] ?? 0
      return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
      ]
    })
    const pane = panes.find((candidate) =>
      triangle.every(
        (point) =>
          Math.abs((point[candidate.axis === 0 ? 0 : 2] ?? 0) - candidate.at) < 0.15 &&
          (point[candidate.axis === 0 ? 2 : 0] ?? 0) >= candidate.a0 - 0.02 &&
          (point[candidate.axis === 0 ? 2 : 0] ?? 0) <= candidate.a1 + 0.02 &&
          (point[1] ?? 0) >= candidate.y0 - 0.02 &&
          (point[1] ?? 0) <= candidate.y1 + 0.02,
      ),
    )
    if (!pane) {
      kept.push(
        oldIndices.getScalar(index),
        oldIndices.getScalar(index + 1),
        oldIndices.getScalar(index + 2),
      )
    }
  }
  primitive.setIndices(
    document
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint32Array(kept))
      .setBuffer(oldIndices.getBuffer()),
  )
}
const buffer = root.listBuffers()[0] ?? document.createBuffer()
const positions = document
  .createAccessor()
  .setType('VEC3')
  .setArray(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]))
  .setBuffer(buffer)
const normals = document
  .createAccessor()
  .setType('VEC3')
  .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]))
  .setBuffer(buffer)
const indices = document
  .createAccessor()
  .setType('SCALAR')
  .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
  .setBuffer(buffer)
const material = document
  .createMaterial('breakable-glass')
  .setBaseColorFactor([0.55, 0.72, 0.77, 0.18])
  .setMetallicFactor(0)
  .setRoughnessFactor(0.12)
  .setAlphaMode('BLEND')
  .setDoubleSided(true)
const mesh = document
  .createMesh('pane')
  .addPrimitive(
    document
      .createPrimitive()
      .setAttribute('POSITION', positions)
      .setAttribute('NORMAL', normals)
      .setIndices(indices)
      .setMaterial(material),
  )
for (const pane of panes) {
  const along = (pane.a0 + pane.a1) / 2
  const node = document
    .createNode(`glass-${pane.index}`)
    .setMesh(mesh)
    .setTranslation(
      pane.axis === 0
        ? [pane.at, (pane.y0 + pane.y1) / 2, along]
        : [along, (pane.y0 + pane.y1) / 2, pane.at],
    )
    .setScale([pane.a1 - pane.a0, pane.y1 - pane.y0, 1])
  if (pane.axis === 0) {
    node.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2])
  }
  town.addChild(node)
}
await io.write(path, document)
console.log(`Authored ${panes.length} individually named panes`)
