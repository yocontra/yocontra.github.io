import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { CATALOG } from '../../src/experiments/out-west/data/catalog.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
async function headSurface(url: string) {
  const { pathname } = new URL(url, 'https://out-west.invalid')
  const doc = await io.read(`public${pathname}`)
  const skin = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .filter((primitive) => primitive.getMaterial()?.getName() === 'Field-worn skin')
  if (skin.length !== 1) {
    throw new Error(`Expected one isolated skin material on ${pathname}, found ${skin.length}`)
  }
  const face = skin[0]
  const indices = face?.getIndices()?.getArray()
  const position = face?.getAttribute('POSITION')
  if (
    !(
      face &&
      indices &&
      position &&
      face.getAttribute('JOINTS_0') &&
      face.getAttribute('WEIGHTS_0')
    )
  ) {
    throw new Error(`Missing skinned head geometry on ${pathname}`)
  }
  const pbr = face.getMaterial()?.getExtras().nativePbr as
    | { albedo?: string; normal?: string }
    | undefined
  if (!(pbr?.albedo?.endsWith('.color.ktx2') && pbr.normal?.endsWith('.data.ktx2'))) {
    throw new Error(`Missing face texture or normal map on ${pathname}`)
  }
  return { indexCount: indices.length, vertexCount: position.getCount(), albedo: pbr.albedo }
}

const starter = headSurface(ASSETS.player.url)
for (const { id, slot } of CATALOG) {
  if (slot === 'outfit') {
    it(`${id} uses the fitted player head in both weapon configurations`, async () => {
      const fit = EQUIPMENT[id as keyof typeof EQUIPMENT]
      if (!('pair' in fit)) {
        throw new Error(`Missing paired player fit for ${id}`)
      }
      const [expected, single, pair] = await Promise.all([
        starter,
        headSurface(fit.url),
        headSurface(fit.pair.url),
      ])
      expect(single).toEqual(expected)
      expect(pair).toEqual(expected)
    })
  }
}
