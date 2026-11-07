/** Inputs that determine a catalog preview; used by the baker and its freshness gate. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCENE = 'src/experiments/out-west/scene'
const CHARACTER_MODULES = [
  'actor',
  'actor-template',
  'actor-options',
  'actor-dress',
  'atlas',
  'bake',
  'bind',
  'cast',
  'coat',
  'clips',
  'collar',
  'engraving',
  'draw',
  'geo',
  'gesture',
  'face',
  'fit',
  'gunbelt',
  'gunsmith',
  'hat-detail',
  'hats',
  'holster',
  'holster-detail',
  'identity',
  'item-studio',
  'kit',
  'loadout',
  'longgun',
  'normals',
  'nudge',
  'outfit',
  'person',
  'poncho',
  'props',
  'revolver',
  'rig',
  'roles',
  'shade',
  'western-shirt',
  'western-sleeves',
  'western-cap',
  'western-weights',
  'western-hands',
  'garment-mesh',
  'style',
  'spurs',
  'wardrobe',
  'western-kit',
  'whiskers',
]
const ART = 'public/experiments/out-west/3d'

export function itemArtInputs(): string[] {
  return [
    ...CHARACTER_MODULES.map((name) => `${SCENE}/${name}.ts`),
    'src/experiments/out-west/data/catalog.ts',
    'src/experiments/out-west/engine/assets.ts',
    'tools/build-characters.ts',
    'tools/item-thumbs.ts',
    'tools/item-art.ts',
    ...readdirSync(`${ART}/models`)
      .filter((name) => name.endsWith('.glb'))
      .map((name) => `${ART}/models/${name}`),
    ...readdirSync(`${ART}/tex`)
      .filter((name) => name.startsWith('char_'))
      .map((name) => `${ART}/tex/${name}`),
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
