import { expect, test as it } from 'bun:test'
import { quantize } from '@gltf-transform/functions'
import { Mat4, Vec3 } from 'playcanvas'
import { body, primitive } from './facial-hair-test-helpers.ts'
import { assertNPC15QuantizedDonor, throatValue } from './head-throat-quantization-helpers.ts'
import { io } from './paired-grip-test-helpers.ts'

it('accepts the real stock quantizer for the two NPC15 donor targets and rejects unedited donors', async () => {
  const source = await io.read('tools/art/characters/outlaw-15.gltf')
  const node = body(source)
  const surface = primitive(node)
  const skin = throatValue(node.getSkin())
  const bind = new Mat4().set(
    throatValue(skin.getInverseBindMatrices()).getElement(
      skin.listJoints().findIndex((j) => j.getName() === 'Head'),
      [],
    ),
  )
  const position = throatValue(surface.getAttribute('POSITION'))
  const head = Array.from({ length: 1555 }, (_, i) =>
    bind.transformPoint(new Vec3(...position.getElement(i, []))),
  )
  const scale = Math.max(...head.map((p) => p.y)) / 0.199_726_505_927_274_6
  const targets = [83, 84].map((i) => ({
    i,
    target: throatValue(head[i])
      .clone()
      .add(new Vec3(0, (i === 83 ? -0.0048 : -0.0036) * scale, 0)),
  }))
  for (const { i, target } of targets) {
    position.setElement(i, bind.clone().invert().transformPoint(target).toArray())
  }
  await source.transform(quantize({ cleanup: false }))
  for (const { i, target } of targets) {
    expect(
      assertNPC15QuantizedDonor({
        id: 'outlaw-15',
        sourceVertex: i,
        node,
        primitive: surface,
        vertex: i,
        expectedHead: target,
      }),
    ).toBeLessThan(0.0002)
    expect(() =>
      assertNPC15QuantizedDonor({
        id: 'outlaw-15',
        sourceVertex: i,
        node,
        primitive: surface,
        vertex: i,
        expectedHead: target.clone().add(new Vec3(0, 0.001, 0)),
      }),
    ).toThrow('cell')
  }
  expect(() =>
    assertNPC15QuantizedDonor({
      id: 'player',
      sourceVertex: 83,
      node,
      primitive: surface,
      vertex: 83,
      expectedHead: throatValue(targets[0]).target,
    }),
  ).toThrow()
  expect(() =>
    assertNPC15QuantizedDonor({
      id: 'outlaw-15',
      sourceVertex: 82,
      node,
      primitive: surface,
      vertex: 83,
      expectedHead: throatValue(targets[0]).target,
    }),
  ).toThrow('No other')
  const old = await io.read('tools/art/characters/outlaw-15.gltf')
  const oldNode = body(old)
  const oldSurface = primitive(oldNode)
  await old.transform(quantize({ cleanup: false }))
  for (const { i, target } of targets) {
    expect(() =>
      assertNPC15QuantizedDonor({
        id: 'outlaw-15',
        sourceVertex: i,
        node: oldNode,
        primitive: oldSurface,
        vertex: i,
        expectedHead: target,
      }),
    ).toThrow('cell')
  }
})
