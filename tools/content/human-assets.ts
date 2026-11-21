/** Rebuild only HUMAN fitted assets; animal/ambient exports keep independent ownership. */
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fitBatteredBrim } from './battered-brim.ts'
import { bakeCharacter } from './character-materials.ts'
import { compressCharacterAssets } from './character-textures.ts'
import { contentOutput } from './content-output.ts'

const source = resolve('tools/art/characters')
const excluded = new Set(['dog', 'horse', 'moves', 'character-actions', 'character-strides'])
const requested = process.env.OUT_WEST_CHARACTERS?.split(',')
const ids = (await readdir(source))
  .filter((file) => file.endsWith('.gltf'))
  .map((file) => file.slice(0, -5))
  .filter(
    (id) => !(excluded.has(id) || id.startsWith('held-')) && (!requested || requested.includes(id)),
  )
if (requested?.some((id) => !ids.includes(id))) {
  throw new Error('HUMAN bake selection contains an unknown or non-human source')
}
process.env.OUT_WEST_CHARACTERS = ids.join(',')
// Keep one atlas/encoder job live at a time to bound the offline memory budget.
for (const id of ids) {
  await bakeCharacter(resolve(source, `${id}.gltf`))
}
await compressCharacterAssets()
if (ids.includes('hat.battered-brim')) {
  await fitBatteredBrim(
    resolve(source, 'hats/battered-brim.glb'),
    contentOutput('equipment', 'hat.battered-brim.glb'),
  )
}
console.log(`Rebuilt ${ids.length} HUMAN fitted assets`)
