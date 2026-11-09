import { expect, test as it } from 'bun:test'
import { type Node as GltfNode, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { buildGrid, TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'

const PANE_NAME = /^glass-\d+$/u

function bounds(node: GltfNode): number[] {
  const position = node.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')
  const matrix = node.getWorldMatrix()
  const minimum = new Array<number>(3).fill(Number.POSITIVE_INFINITY)
  const maximum = new Array<number>(3).fill(Number.NEGATIVE_INFINITY)
  for (let index = 0; index < (position?.getCount() ?? 0); index++) {
    const [x = 0, y = 0, z = 0] = position?.getElement(index, []) ?? []
    for (let axis = 0; axis < 3; axis++) {
      const value =
        (matrix[axis] ?? 0) * x +
        (matrix[axis + 4] ?? 0) * y +
        (matrix[axis + 8] ?? 0) * z +
        (matrix[axis + 12] ?? 0)
      minimum[axis] = Math.min(minimum[axis] ?? Number.POSITIVE_INFINITY, value)
      maximum[axis] = Math.max(maximum[axis] ?? Number.NEGATIVE_INFINITY, value)
    }
  }
  return [...minimum, ...maximum]
}

it('exactly296 original textured panes remain, with stable indices and no duplicate glazing', async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const [document, source] = await Promise.all([
    io.read(`public${ASSETS.frontier.url.split('?')[0]}`),
    io.read('tools/art/environments/frontier.glb'),
  ])
  const nodes = new Map(
    document
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  )
  const panes = buildGrid(TOWN).glass
  const original = source
    .getRoot()
    .listNodes()
    .filter((node) => node.getName().startsWith('window-glass-'))
  const glazing = [...nodes.values()].filter((node) =>
    node
      .getMesh()
      ?.listPrimitives()
      .some((primitive) => primitive.getMaterial()?.getName() === 'window-glass'),
  )
  expect(panes).toHaveLength(296)
  expect(glazing).toHaveLength(296)
  expect(original).toHaveLength(296)
  expect([...nodes.keys()].filter((name) => PANE_NAME.test(name))).toHaveLength(panes.length)
  expect([...nodes.keys()].some((name) => name.startsWith('window-glass-'))).toBe(false)
  expect(
    document
      .getRoot()
      .listMaterials()
      .some((material) => material.getName() === 'breakable-glass'),
  ).toBe(false)
  for (const pane of panes) {
    const node = nodes.get(`glass-${pane.index}`)
    if (!node) {
      throw new Error(`Missing authored pane ${pane.index}`)
    }
    const position = node.getWorldTranslation()
    expect(position[1]).toBeCloseTo((pane.y0 + pane.y1) / 2)
    expect(position[pane.axis === 0 ? 0 : 2]).toBeCloseTo(pane.at)
    const authored = original.find((candidate) =>
      candidate
        .getWorldTranslation()
        .every((value, axis) => Math.abs(value - (position[axis] ?? 0)) < 0.001),
    )
    if (!authored) {
      throw new Error(`Pane ${pane.index} lost its original textured source`)
    }
    const expected = bounds(authored)
    for (const [axis, value] of bounds(node).entries()) {
      expect(value).toBeCloseTo(expected[axis] ?? 0, 3)
    }
    const primitive = node.getMesh()?.listPrimitives()[0]
    const sourcePrimitive = authored.getMesh()?.listPrimitives()[0]
    expect(
      [...(primitive?.getAttribute('TEXCOORD_0')?.getArray() ?? [])].sort((a, b) => a - b),
    ).toEqual(
      [...(sourcePrimitive?.getAttribute('TEXCOORD_0')?.getArray() ?? [])].sort((a, b) => a - b),
    )
    const material = primitive?.getMaterial()
    const sourceMaterial = sourcePrimitive?.getMaterial()
    expect(material?.getName()).toBe('window-glass')
    expect(material?.getAlphaMode()).toBe('BLEND')
    expect(material?.getBaseColorFactor()).toEqual(sourceMaterial?.getBaseColorFactor())
    expect(material?.getMetallicFactor()).toBe(sourceMaterial?.getMetallicFactor())
    expect(material?.getRoughnessFactor()).toBe(sourceMaterial?.getRoughnessFactor())
    expect(material?.getBaseColorTexture()?.getMimeType()).toBe('image/ktx2')
  }
})
