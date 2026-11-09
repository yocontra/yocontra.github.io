/** Author independently addressable panes once; the runtime toggles native entities. */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import { buildGrid, TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'

const path = 'public/experiments/out-west/3d/native-v2/baked/frontier.glb'
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const document = await io.read(path)
const root = document.getRoot()
const town = root.listNodes().find((node) => node.getName() === 'town')
if (!town) {
  throw new Error('Missing authored town')
}
const panes = buildGrid(TOWN).glass
const authored = root.listNodes().filter((node) =>
  node
    .getMesh()
    ?.listPrimitives()
    .some((primitive) => primitive.getMaterial()?.getName() === 'window-glass'),
)
if (authored.length !== panes.length) {
  throw new Error(`Expected ${panes.length} authored panes, found ${authored.length}`)
}
const assigned = new Set<(typeof authored)[number]>()
for (const pane of panes) {
  const along = (pane.a0 + pane.a1) / 2
  const position =
    pane.axis === 0
      ? [pane.at, (pane.y0 + pane.y1) / 2, along]
      : [along, (pane.y0 + pane.y1) / 2, pane.at]
  const matches = authored.filter((candidate) => {
    const world = candidate.getWorldTranslation()
    return Math.hypot(...world.map((value, axis) => value - (position[axis] ?? 0))) < 0.001
  })
  const node = matches[0]
  if (!node || matches.length !== 1 || assigned.has(node)) {
    throw new Error(`Pane ${pane.index} must match exactly one authored textured plane`)
  }
  assigned.add(node)
  node.setName(`glass-${pane.index}`)
}
// Older bakes added a second, untextured plane over the original glazing.
for (const node of root.listNodes()) {
  if (
    node
      .getMesh()
      ?.listPrimitives()
      .some((primitive) => primitive.getMaterial()?.getName() === 'breakable-glass')
  ) {
    node.dispose()
  }
}
// Remove opaque old facade faces at real openings; each pane can disappear independently.
const facade = root
  .listNodes()
  .find((node) => node.getName() === 'windows' || node.getName().startsWith('windows-'))
const facadePrimitive = facade?.getMesh()?.listPrimitives()[0]
const facadePosition = facadePrimitive?.getAttribute('POSITION')
const oldIndices = facadePrimitive?.getIndices()
if (facade && facadePrimitive && facadePosition && oldIndices) {
  const matrix = facade.getWorldMatrix()
  const kept: number[] = []
  for (let index = 0; index < oldIndices.getCount(); index += 3) {
    const triangle = [0, 1, 2].map((offset) => {
      const value = facadePosition.getElement(oldIndices.getScalar(index + offset), [])
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
  facadePrimitive.setIndices(
    document
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint32Array(kept))
      .setBuffer(oldIndices.getBuffer()),
  )
}
await document.transform(prune({ keepLeaves: true, keepAttributes: true }))
await io.write(path, document)
console.log(`Indexed ${panes.length} original textured panes without duplicate glazing`)
