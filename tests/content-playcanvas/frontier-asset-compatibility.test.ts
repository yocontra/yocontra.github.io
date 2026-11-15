import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'

it('clients without native LOD retain their original Frontier container', async () => {
  const original = await readFile('public/experiments/out-west/3d/native-v2/baked/frontier.glb')
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    // biome-ignore lint/security/noSecrets: immutable public asset SHA-256, not a credential
    '653a1eb9cb936e4f947895d93bcb18f24bd02f7ad34ffe4fb7e7b35e32a1d952',
  )
  expect(ASSETS.frontier.url.split('?')[0]).toBe(
    '/experiments/out-west/3d/native-v2/baked/frontier-detail.glb',
  )
  const current = await readFile(`public${ASSETS.frontier.url.split('?')[0]}`)
  expect(createHash('sha256').update(current).digest('hex')).toBe(ASSETS.frontier.hash)
  expect(current.byteLength).toBe(ASSETS.frontier.bytes)
})
