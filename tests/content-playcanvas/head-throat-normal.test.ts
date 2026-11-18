import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import { pixels } from '../../tools/content/character-atlas.ts'
import {
  assertHeadThroatNormalSources,
  assertOutwardNormalPixels,
  patchHeadThroatNormalAtlas,
  withHeadThroatNormalSource,
} from '../../tools/content/head-throat-normal.ts'
import domain from '../../tools/content/head-throat-normal-domain.json' with { type: 'json' }
import { THROAT_NORMAL_IDS } from '../../tools/content/head-throat-plan.ts'
import { io } from './paired-grip-test-helpers.ts'

it('the native nape bake leaves the lower-neck error texels to the source atlas', async () => {
  const { data, info } = await sharp('tools/art/characters/head-nape/neck-normal.png')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect(assertOutwardNormalPixels(data)).toBeGreaterThan(7000)
  const { atlas } = JSON.parse(
    await readFile('tools/art/characters/head-nape/lattice.json', 'utf8'),
  )
  const alpha = domain.lowerNeckExcludedPixels.map(
    ([x = 0, y = 0]) => data[((y - atlas.normal.y) * info.width + x - atlas.normal.x) * 4 + 3],
  )
  expect(alpha).toEqual(domain.lowerNeckExcludedPixels.map(() => 0))
})
it('accepts outward unit normals and leaves transparent atlas space unowned', () => {
  expect(assertOutwardNormalPixels(new Uint8Array([128, 128, 255, 255, 0, 0, 0, 0]))).toBe(1)
})
for (const [name, rgba] of [
  ['inward', [128, 128, 0, 255]],
  ['near-zero', [130, 127, 127, 255]],
  ['partial mask', [128, 128, 255, 128]],
] as const) {
  it(`rejects a ${name} tangent normal instead of clamping or painting it`, () => {
    expect(() => assertOutwardNormalPixels(new Uint8Array(rgba))).toThrow()
  })
}
it('rejects an empty native mask', () => {
  expect(() => assertOutwardNormalPixels(new Uint8Array([0, 0, 0, 0]))).toThrow('empty')
})

it('the actual native mask changes only its owned atlas pixels and stays scoped to its actor', async () => {
  const artifact = await io.read('tools/art/characters/head-throat-normal/atlas.gltf')
  await validateAuthoringInputs(artifact)
  const patch = artifact.getRoot().getExtras().normalPatch as {
    image: string
    x: number
    y: number
    width: number
    sourceIds: string[]
  }
  const png = await sharp(await readFile(`tools/art/characters/head-throat-normal/${patch.image}`))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect(assertOutwardNormalPixels(png.data)).toBeGreaterThan(0)
  expect(patch.sourceIds).toContain('player')
  const source = await io.read('tools/art/characters/player.gltf')
  const texture = source
    .getRoot()
    .listTextures()
    .find((t) => t === source.getRoot().listMaterials()[0]?.getNormalTexture())
  const bytes = texture?.getImage()
  if (!(texture && bytes)) {
    throw new Error('Missing real canonical skin normal texture')
  }
  const original = await pixels(texture)
  const candidate = { ...original, data: Buffer.from(original.data) }
  await withHeadThroatNormalSource('player', () => patchHeadThroatNormalAtlas(bytes, candidate))
  let changed = 0
  let outside = 0
  for (let pixel = 0; pixel < original.width * original.height; pixel++) {
    const delta = [0, 1, 2, 3].some(
      (c) => original.data[pixel * 4 + c] !== candidate.data[pixel * 4 + c],
    )
    if (!delta) {
      continue
    }
    changed++
    const x = (pixel % original.width) - patch.x
    const y = Math.floor(pixel / original.width) - patch.y
    const owned =
      x >= 0 &&
      x < png.info.width &&
      y >= 0 &&
      y < png.info.height &&
      png.data[(y * png.info.width + x) * 4 + 3] === 255
    if (!owned) {
      outside++
    }
  }
  expect(changed).toBeGreaterThan(0)
  expect(outside).toBe(0)
  const unrelated = { ...original, data: Buffer.from(original.data) }
  await withHeadThroatNormalSource('unrelated-normal-consumer', () =>
    patchHeadThroatNormalAtlas(bytes, unrelated),
  )
  expect(unrelated.data.equals(original.data)).toBe(true)
})

it('requires exact male32 normal ownership and excludes both alternative heads', () => {
  expect(() => assertHeadThroatNormalSources(THROAT_NORMAL_IDS)).not.toThrow()
  expect(() => assertHeadThroatNormalSources(['player', 'outlaw-16'])).toThrow('32')
  expect(() => assertHeadThroatNormalSources([...THROAT_NORMAL_IDS, 'outlaw-8'])).toThrow('32')
  expect(() => assertHeadThroatNormalSources([...THROAT_NORMAL_IDS.slice(1), 'outlaw-10'])).toThrow(
    '32',
  )
  expect(() =>
    assertHeadThroatNormalSources([...THROAT_NORMAL_IDS.slice(1), THROAT_NORMAL_IDS[1] ?? '']),
  ).toThrow('32')
})
