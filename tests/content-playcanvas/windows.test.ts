import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { buildGrid, TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'

const PANE_NAME = /^glass-\d+$/u

it('authored breakable panes address every domain window with matching placement', async () => {
  const document = await new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .read('public/experiments/out-west/3d/baked/frontier.glb')
  const nodes = new Map(
    document
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  )
  const panes = buildGrid(TOWN).glass
  expect([...nodes.keys()].filter((name) => PANE_NAME.test(name))).toHaveLength(panes.length)
  for (const pane of panes) {
    const node = nodes.get(`glass-${pane.index}`)
    if (!node) {
      throw new Error(`Missing authored pane ${pane.index}`)
    }
    const position = node.getTranslation()
    expect(position[1]).toBeCloseTo((pane.y0 + pane.y1) / 2)
    expect(position[pane.axis === 0 ? 0 : 2]).toBeCloseTo(pane.at)
    expect(node.getScale().slice(0, 2)).toEqual([pane.a1 - pane.a0, pane.y1 - pane.y0])
    expect(node.getMesh()?.listPrimitives()[0]?.getMaterial()?.getAlphaMode()).toBe('BLEND')
  }
})
