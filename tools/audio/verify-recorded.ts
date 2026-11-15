/** Verify recorded Frontier source provenance and isolated variants in shipped atlases. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SOUNDS } from '../../src/experiments/out-west/client/frontier-sounds.ts'
import { FREESOUND } from './cc0.ts'
import { load, peak, slice } from './dsp.ts'
import { FRONTIER_GRIDS, shipped } from './frontier-grid.ts'

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

const recorded = [
  FREESOUND.magnumExterior,
  FREESOUND.revolver38Session,
  FREESOUND.cowboyBoards,
  FREESOUND.timber319223,
  FREESOUND.timber319226,
  FREESOUND.timber319227,
  FREESOUND.timber319228,
]
for (const source of recorded) {
  check(
    createHash('sha256')
      .update(await readFile(source.file))
      .digest('hex') === source.sha256,
    `${source.file} source checksum changed`,
  )
  check(source.license.startsWith('CC0 1.0'), `${source.file} license is not CC0`)
}
for (const sound of [SOUNDS.shot, SOUNDS.tail, SOUNDS.stepWood, SOUNDS.wood]) {
  const grid = FRONTIER_GRIDS[sound.file]
  check(
    sound.grid.count === grid.count && sound.grid.step === grid.step && sound.grid.len === grid.len,
    `${sound.file} runtime and authored grids differ`,
  )
  const audio = load(shipped(sound.file), 1)
  for (let variant = 0; variant < grid.count; variant++) {
    const at = variant * grid.step
    check(peak(slice(audio, at, at + grid.len)) > 0.01, `${sound.file} variant ${variant} empty`)
    // Codec ringing gets 20 ms of margin; no second event may spill into the next slot.
    check(
      peak(slice(audio, at + grid.len + 0.02, at + grid.step - 0.02)) < 0.003,
      `${sound.file} variant ${variant} spills into its guard interval`,
    )
  }
}
console.log('PASS: 7 verified CC0 sources, 24 isolated variants and native grids')
