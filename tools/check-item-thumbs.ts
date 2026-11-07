/** Fail when catalog preview images no longer match their art inputs or were replaced piecemeal. */
import { existsSync, readFileSync } from 'node:fs'
import { CATALOG } from '../src/experiments/out-west/data/catalog.ts'
import { hasThumb } from '../src/experiments/out-west/scene/item-studio.ts'
import { BAKED_THUMBS } from '../src/experiments/out-west/ui/thumbs.ts'
import { fileHash, itemArtFingerprint } from './item-art.ts'

const dir = new URL('../public/experiments/out-west/thumbs/', import.meta.url).pathname
const manifestPath = `${dir}manifest.json`
if (!existsSync(manifestPath)) {
  throw new Error(
    'Missing preview manifest. Run bun tools/item-thumbs.ts against the local dev server.',
  )
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  fingerprint: string
  images: Record<string, string>
}
if (manifest.fingerprint !== itemArtFingerprint()) {
  throw new Error(
    'Outfitter previews are stale. Re-run bun tools/item-thumbs.ts after changing character or equipment art.',
  )
}
const visible = CATALOG.filter((candidate) => hasThumb(candidate.slot))
const expected = new Set(visible.map((item) => item.id))
if (
  BAKED_THUMBS.size !== expected.size ||
  [...BAKED_THUMBS].some((id) => !expected.has(id)) ||
  Object.keys(manifest.images).length !== expected.size
) {
  throw new Error('Preview catalog/manifest mismatch. Re-run the complete thumbnail bake.')
}
for (const item of visible) {
  const path = `${dir}${item.id}.webp`
  if (!existsSync(path) || manifest.images[item.id] !== fileHash(path)) {
    throw new Error(`Missing or changed preview: ${item.id}. Re-run the complete thumbnail bake.`)
  }
}
console.log(`Outfitter previews current: ${Object.keys(manifest.images).length} images`)
