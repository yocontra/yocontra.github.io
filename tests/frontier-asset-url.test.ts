import { expect, it, spyOn } from 'bun:test'
import { Texture, TextureLoader } from 'three'
import { assetUrl } from '../src/experiments/out-west/platform/asset-url.ts'
import { loadTex, setLowRes } from '../src/experiments/out-west/scene/textures.ts'

it('keys deployment assets by revision while preserving paths, queries and fragments', () => {
  const revised = assetUrl('/experiments/out-west/3d/models/casual.glb?variant=1#mesh', 'a b&c')
  const parsed = new URL(revised, 'https://contra.io')
  expect(parsed.pathname).toBe('/experiments/out-west/3d/models/casual.glb')
  expect(parsed.searchParams.get('variant')).toBe('1')
  expect(parsed.searchParams.get('owrev')).toBe('a b&c')
  expect(parsed.hash).toBe('#mesh')
  expect(assetUrl(revised, 'next')).toContain('owrev=next')
  expect(
    new URL(assetUrl(revised, 'next'), 'https://contra.io').searchParams.getAll('owrev'),
  ).toEqual(['next'])
  expect(assetUrl('https://contra.io/x.webp?x=1#part', 'abc')).toBe(
    'https://contra.io/x.webp?x=1&owrev=abc#part',
  )
})

it('keeps development and inline URLs unchanged', () => {
  expect(assetUrl('/x.webp?q=1#part', '')).toBe('/x.webp?q=1#part')
  expect(assetUrl('data:image/svg+xml,a?b#c', 'revision')).toBe('data:image/svg+xml,a?b#c')
  expect(assetUrl('blob:https://contra.io/abc', 'revision')).toBe('blob:https://contra.io/abc')
})

it('revisions both half-texture and full fallback without corrupting an existing query', async () => {
  const env = import.meta.env
  const before = env.PUBLIC_OW_ASSET_REVISION
  env.PUBLIC_OW_ASSET_REVISION = 'fixture-sha'
  setLowRes(true)
  const requested: string[] = []
  const loaded = new Texture<HTMLImageElement>()
  const load = spyOn(TextureLoader.prototype, 'load').mockImplementation(
    (url, onLoad, _progress, onError) => {
      requested.push(url)
      if (requested.length === 1) {
        onError?.(new Error('No half-size asset'))
      } else {
        onLoad?.(loaded)
      }
      return loaded
    },
  )
  try {
    expect(
      await loadTex('/experiments/out-west/3d/tex/char_diff.webp?variant=1#map', true, 4),
    ).toBe(loaded)
    expect(requested).toEqual([
      '/experiments/out-west/3d/tex/char_diff-half.webp?variant=1&owrev=fixture-sha#map',
      '/experiments/out-west/3d/tex/char_diff.webp?variant=1&owrev=fixture-sha#map',
    ])
  } finally {
    load.mockRestore()
    setLowRes(false)
    if (before === undefined) {
      Reflect.deleteProperty(env, 'PUBLIC_OW_ASSET_REVISION')
    } else {
      env.PUBLIC_OW_ASSET_REVISION = before
    }
    loaded.dispose()
  }
})
