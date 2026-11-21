/** Outfit campaign actors with new hats while retaining the authored rig mounts. */
import { resolve } from 'node:path'
import { type HatKey, OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import { contentOutput } from './content-output.ts'
import { fitAuthoredHat } from './fitted-hat.ts'

const idPattern = /^outlaw-(?<index>\d+)$/u
const silhouettes = {
  cowboy: 'range-hat',
  bowler: 'derby',
  flat: 'flat-cap',
  tall: 'tall-cattleman',
  tophat: 'stovepipe',
  sombrero: 'sombrero',
} satisfies Record<HatKey, string>

export async function fitOutlawHat(id: string): Promise<void> {
  const index = Number(idPattern.exec(id)?.groups?.index)
  const outlaw = OUTLAWS[index]
  if (!outlaw) {
    throw new Error(`No outlaw hat for ${id}`)
  }
  const name = index === 0 ? 'greenhorn' : silhouettes[outlaw.hat]
  const catalogue = outlaw.hat === 'tophat' || outlaw.hat === 'sombrero'
  const source = resolve('tools/art/characters', catalogue ? 'hats' : 'outlaw-hats', `${name}.glb`)
  await fitAuthoredHat(source, contentOutput('baked', `${id}.glb`), 'actor')
}

if (import.meta.main) {
  for (let index = 0; index < OUTLAWS.length; index++) {
    await fitOutlawHat(`outlaw-${index}`)
  }
}
