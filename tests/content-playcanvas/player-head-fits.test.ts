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
  const surfaces = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
  const skin = surfaces.filter(
    (primitive) => primitive.getMaterial()?.getName() === 'Field-worn skin',
  )
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
    | { albedo?: string; normal?: string; surface?: string }
    | undefined
  if (
    !(
      pbr?.surface === 'skin' &&
      pbr.albedo?.endsWith('.color.ktx2') &&
      pbr.normal?.endsWith('.data.ktx2')
    )
  ) {
    throw new Error(`Missing tagged skin, color texture or normal map on ${pathname}`)
  }
  const styledHair = surfaces.filter(
    (primitive) => primitive.getMaterial()?.getName() === 'Tobacco brown hair',
  )
  const hair = styledHair[0]
  const hairMaterial = hair?.getMaterial()
  const combedScalp = hairMaterial?.getExtras().nativePbr as
    | { albedo?: string; normal?: string; alphaTest?: number }
    | undefined
  if (
    styledHair.length !== 1 ||
    (hair?.getAttribute('POSITION')?.getCount() ?? 0) < 1000 ||
    !hair?.getAttribute('JOINTS_0') ||
    !hair.getAttribute('WEIGHTS_0') ||
    hairMaterial?.getAlphaMode() !== 'MASK' ||
    combedScalp?.alphaTest !== 0.5 ||
    !combedScalp.albedo?.endsWith('.color.ktx2') ||
    !combedScalp.normal?.endsWith('.data.ktx2')
  ) {
    throw new Error(`Missing the skinned groom, coverage or strand maps on ${pathname}`)
  }
  return {
    indexCount: indices.length,
    vertexCount: position.getCount(),
    albedo: pbr.albedo,
    groom: combedScalp.albedo,
  }
}

const starter = headSurface(ASSETS.player.url)
for (const { id, slot } of CATALOG) {
  if (slot === 'outfit' && id !== 'outfit.trail-duds') {
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

it('fits the scanned Trail Duds face to both gameplay rigs', async () => {
  const fit = EQUIPMENT['outfit.trail-duds']
  const faces = await Promise.all(
    [fit, fit.pair].map(async ({ url }) => {
      const doc = await io.read(`public${new URL(url, 'https://out-west.invalid').pathname}`)
      const surfaces = doc
        .getRoot()
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives())
      const face = surfaces.find((part) => part.getMaterial()?.getName() === 'Rider beard and skin')
      expect(face?.getAttribute('JOINTS_0')).toBeDefined()
      expect(face?.getAttribute('WEIGHTS_0')).toBeDefined()
      expect(face?.getMaterial()?.getBaseColorTexture()?.getImage()?.length).toBeGreaterThan(1000)
      return face?.getAttribute('POSITION')?.getArray()
    }),
  )
  expect(faces[0]).toEqual(faces[1])
})
