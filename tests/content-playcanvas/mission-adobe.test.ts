import { expect, test as it } from 'bun:test'
import type { Primitive } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'
import { frontierIO } from '../../tools/content/frontier-geometry.ts'
import { dressMissionAdobe } from '../../tools/content/mission-adobe.ts'

function surfaceArea(primitive: Primitive): number {
  const positions = primitive.getAttribute('POSITION')
  if (!positions) {
    throw new Error('Missing positions')
  }
  const indices = primitive.getIndices()
  const read = (index: number) =>
    new Vec3().fromArray(positions.getElement(indices?.getScalar(index) ?? index, []))
  let area = 0
  for (let i = 0; i < (indices?.getCount() ?? positions.getCount()); i += 3) {
    const origin = read(i)
    area += new Vec3().cross(read(i + 1).sub(origin), read(i + 2).sub(origin)).length() / 2
  }
  return area
}

it('bakes the 2 m plaster scan and weathering without moving the mission walls', async () => {
  const document = await frontierIO.read('tools/art/environments/mission.glb')
  const root = document.getRoot()
  const mesh = root
    .listNodes()
    .find((node) => node.getName() === 'adobe-6')
    ?.getMesh()
  const primitive = mesh?.listPrimitives()[0]
  const material = primitive?.getMaterial()
  if (!(primitive && material)) {
    throw new Error('Missing mission adobe')
  }
  const position = primitive.getAttribute('POSITION')
  const originalUV = primitive.getAttribute('TEXCOORD_0')
  const unrelated = root
    .listMeshes()
    .filter((entry) => entry !== mesh)
    .flatMap((entry) =>
      entry.listPrimitives().map((part) => [part.getIndices(), ...part.listAttributes()]),
    )
  const area = surfaceArea(primitive)

  await dressMissionAdobe(document)

  const bakedPosition = primitive.getAttribute('POSITION')
  const colors = primitive.getAttribute('COLOR_0')
  expect(bakedPosition?.getMin([])).toEqual(position?.getMin([]))
  expect(bakedPosition?.getMax([])).toEqual(position?.getMax([]))
  expect(surfaceArea(primitive)).toBeCloseTo(area, 4)
  expect(bakedPosition?.getCount() ?? 0).toBeGreaterThan(position?.getCount() ?? 0)
  expect(colors?.getCount()).toBe(bakedPosition?.getCount())
  const bakedUV = primitive.getAttribute('TEXCOORD_0')
  expect(bakedUV?.getMax([])[0]).toBeCloseTo((originalUV?.getMax([])[0] ?? 0) * 1.6, 5)
  expect(material.getExtras().earthPlasterRepeatMeters).toBe(2)
  expect(material.getBaseColorTexture()?.getName()).toBe('clay_plaster diff')
  expect(material.getNormalTexture()?.getName()).toBe('clay_plaster nor')
  expect(material.getMetallicRoughnessTexture()?.getName()).toBe('clay_plaster arm')
  expect(material.getOcclusionTexture()).toBe(material.getMetallicRoughnessTexture())
  expect(
    root
      .listMeshes()
      .filter((entry) => entry !== mesh)
      .flatMap((entry) =>
        entry.listPrimitives().map((part) => [part.getIndices(), ...part.listAttributes()]),
      ),
  ).toEqual(unrelated)
})
