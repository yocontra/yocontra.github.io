/** Rebuild only HUMAN fitted assets; animal/ambient exports keep independent ownership. */
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bakeCharacter } from './character-materials.ts'
import { compressCharacterAssets } from './character-textures.ts'
import { contentOutput } from './content-output.ts'
import { fitAccessory } from './fitted-accessory.ts'
import { fitAuthoredHat } from './fitted-hat.ts'
import { fitHolsterPockets } from './fitted-holster-pockets.ts'
import { fitRevolver } from './fitted-revolver.ts'
import { fitEarlyCastHead, fitGreenhornHead, fitStarterHead } from './fitted-starter-head.ts'
import { fitForgedSpurs } from './forged-spurs.ts'
import { fitOutlawHat } from './outlaw-hats.ts'

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
for (const id of ids.filter((asset) => asset.startsWith('hat.'))) {
  const replacement = resolve(source, 'hats', `${id.slice(4)}.glb`)
  if (await Bun.file(replacement).exists()) {
    await fitAuthoredHat(replacement, contentOutput('equipment', `${id}.glb`))
  }
}
for (const id of ids.filter((asset) =>
  ['player', 'outfit.trail-duds', 'outfit.trail-duds.pair'].includes(asset),
)) {
  await fitStarterHead(
    resolve(source, `${id}.gltf`),
    resolve(source, 'starter-head.glb'),
    contentOutput(id === 'player' ? 'baked' : 'equipment', `${id}.glb`),
  )
}
for (const id of ids.filter((asset) => asset.startsWith('outlaw-'))) {
  await fitOutlawHat(id)
}
if (ids.includes('outlaw-0')) {
  await fitGreenhornHead(
    {
      source: resolve(source, 'outlaw-0.gltf'),
      authoring: resolve(source, 'outlaw-faces/outlaw-0.glb'),
      target: contentOutput('baked', 'outlaw-0.glb'),
    },
    resolve(source, 'starter-head.glb'),
  )
}
for (const index of [1, 3]) {
  const id = `outlaw-${index}`
  if (ids.includes(id)) {
    await fitEarlyCastHead(
      {
        source: resolve(source, `${id}.gltf`),
        authoring: resolve(source, `outlaw-faces/${id}.glb`),
        target: contentOutput('baked', `${id}.glb`),
      },
      { id: index, palette: resolve(source, 'starter-head.glb') },
    )
  }
}
for (const id of ids.filter((asset) => asset.startsWith('spurs.'))) {
  await fitForgedSpurs(
    resolve(source, 'spurs', `${id.slice(6)}.glb`),
    resolve(source, `${id}.gltf`),
    contentOutput('equipment', `${id}.glb`),
  )
}
for (const id of ids.filter((asset) => asset.startsWith('holster.'))) {
  const style = id.slice(8).replace('.pair', '')
  await fitHolsterPockets(
    resolve(source, 'holster-pockets', `${style}.glb`),
    resolve(source, `${id}.gltf`),
    contentOutput('equipment', `${id}.glb`),
  )
}
for (const [id, artwork, binding] of [
  ['extra.tin-star', 'tin-star', 'badge'],
  ['extra.red-bandana', 'bandana', 'bandana'],
  ['extra.black-bandana', 'bandana', 'bandana'],
  ['extra.handlebar', 'handlebar', 'hair'],
] as const) {
  if (ids.includes(id)) {
    await fitAccessory(
      resolve(source, 'accessories', `${artwork}.glb`),
      resolve(source, `${id}.gltf`),
      contentOutput('equipment', `${id}.glb`),
      binding,
    )
  }
}
for (const id of ids.filter((asset) => asset.startsWith('gun.'))) {
  await fitRevolver(
    resolve(source, 'revolver-exteriors', id === 'gun.buntline' ? 'long.glb' : 'standard.glb'),
    contentOutput('equipment', `${id}.glb`),
  )
}
console.log(`Rebuilt ${ids.length} HUMAN fitted assets`)
