/** The canonical native GLBs and studio determine every catalogue preview. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Slot } from '../src/experiments/out-west/data/catalog.ts'

const ART = 'public/experiments/out-west/3d'
export const hasThumb = (slot: Slot): boolean =>
  ['hat', 'gun', 'outfit', 'extra', 'spurs', 'holster'].includes(slot)
export function itemArtInputs(): string[] {
  return [
    'src/experiments/out-west/data/catalog.ts',
    'src/experiments/out-west/client/application.ts',
    'tools/content/item-preview.ts',
    'tools/item-thumbs.ts',
    'tools/item-art.ts',
    ...readdirSync(`${ART}/equipment`)
      .filter((name) => name.endsWith('.glb'))
      .map((name) => `${ART}/equipment/${name}`),
    `${ART}/env/kloppenheim_06_puresky_1k.hdr`,
  ].sort((a, b) => a.localeCompare(b))
}
export function itemArtFingerprint(): string {
  const hash = createHash('sha256')
  for (const path of itemArtInputs()) {
    hash.update(path)
    hash.update(readFileSync(join(import.meta.dir, '..', path)))
  }
  return hash.digest('hex')
}
export const fileHash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
