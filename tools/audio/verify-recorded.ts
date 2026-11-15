// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone CLI verifies shipped artifacts, not a test runner file.
/** Verify recorded Frontier source provenance and isolated variants in shipped atlases. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SOUNDS } from '../../src/experiments/out-west/client/frontier-sounds.ts'
import { FREESOUND } from './cc0.ts'
import { load, peak, slice } from './dsp.ts'
import { FRONTIER_GRIDS, shipped } from './frontier-grid.ts'

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
  assert.equal(
    createHash('sha256')
      .update(await readFile(source.file))
      .digest('hex'),
    source.sha256,
  )
  assert.match(source.license, /^CC0 1.0/u)
}
for (const sound of [SOUNDS.shot, SOUNDS.tail, SOUNDS.stepWood, SOUNDS.wood]) {
  const grid = FRONTIER_GRIDS[sound.file]
  assert.deepEqual(sound.grid, grid)
  const audio = load(shipped(sound.file), 1)
  for (let variant = 0; variant < grid.count; variant++) {
    const at = variant * grid.step
    assert.ok(
      peak(slice(audio, at, at + grid.len)) > 0.01,
      `${sound.file} variant ${variant} empty`,
    )
    // Codec ringing gets 20 ms of margin; no second event may spill into the next slot.
    assert.ok(
      peak(slice(audio, at + grid.len + 0.02, at + grid.step - 0.02)) < 0.003,
      `${sound.file} variant ${variant} spills into its guard interval`,
    )
  }
}
console.log('PASS: 7 verified CC0 sources, 24 isolated variants and native grids')
