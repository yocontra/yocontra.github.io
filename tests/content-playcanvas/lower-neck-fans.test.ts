import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { integrateGarmentParts } from '../../tools/content/garment-parts.ts'
import { repairLowerNeckFans } from '../../tools/content/lower-neck-fans.ts'

const io = new NodeIO()

for (const id of ['player', 'outfit.striped-poncho.pair']) {
  it(`${id} repairs only its original folded lower-neck faces`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    await integrateGarmentParts(doc, id)
    const body = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === 'Character' && node.getSkin())
    const mesh = body?.getMesh()?.listPrimitives()[0]
    const original = mesh?.getIndices()?.getArray()
    if (!(mesh && original)) {
      throw new Error('Missing indexed lower-neck fixture')
    }
    const attributes = mesh
      .listAttributes()
      .map((attribute) => attribute.getArray()?.slice() ?? null)
    const skin = body?.getSkin()
    repairLowerNeckFans(doc)

    const expected = Array.from(original)
    if (id === 'player') {
      for (const [before, after] of [
        [
          [151, 147, 146, 151, 146, 152, 151, 152, 153],
          [151, 147, 153, 147, 146, 153],
        ],
        [
          [177, 176, 178, 177, 178, 179, 177, 179, 6],
          [177, 176, 6, 176, 179, 6],
        ],
      ] as const) {
        const offset = expected.findIndex(
          (_, i) => i % 3 === 0 && before.every((value, j) => expected[i + j] === value),
        )
        if (offset < 0) {
          throw new Error('Missing original folded triangle fan')
        }
        expected.splice(offset, before.length, ...after)
      }
    }
    expect(Array.from(mesh.getIndices()?.getArray() ?? [])).toEqual(expected)
    expect(mesh.listAttributes().map((attribute) => attribute.getArray())).toEqual(attributes)
    expect(body?.getSkin()).toBe(skin)

    const repaired = mesh.getIndices()
    repairLowerNeckFans(doc)
    expect(mesh.getIndices()).toBe(repaired)
  })
}
