/**
 * Where a window pane is, for the client's break FX: the same shared opening table the sim broke it
 * in, indexed the same way.
 */

import { townWindows, windowPane } from '../sim/building-rules.ts'
import { TOWN } from '../sim/layout.ts'
import { play } from './event-sounds.ts'
import type { Sink } from './events.ts'

/** Shatter FX: one spark per shard burst, and the bottle sample's gain. */
const GLASS_SPARKS = 3
const GLASS_SOUND_GAIN = 0.7

/** Window pane centres by shared index: xyz per opening, built once on the first break. */
let centres: Float64Array | null = null

/** Centre of a window pane by its shared index, or null if the index is unknown. */
function windowCentre(index: number): { x: number; y: number; z: number } | null {
  if (centres === null) {
    const all = townWindows(TOWN)
    centres = new Float64Array(all.length * 3)
    for (const { b, w, index: i } of all) {
      const pane = windowPane(b, w)
      const across = (pane.a0 + pane.a1) / 2
      centres[i * 3] = pane.axis === 0 ? pane.at : across
      centres[i * 3 + 1] = (pane.y0 + pane.y1) / 2
      centres[i * 3 + 2] = pane.axis === 0 ? across : pane.at
    }
  }
  if (index < 0 || index * 3 + 2 >= centres.length) {
    return null
  }
  return {
    x: centres[index * 3] ?? 0,
    y: centres[index * 3 + 1] ?? 1.5,
    z: centres[index * 3 + 2] ?? 0,
  }
}

/** The scene's pane vanishes, shards spark at it, and the bottle sample plays where it broke. */
export function onGlassBreak(s: Sink, index: number): void {
  s.breakWindow(index)
  const at = windowCentre(index)
  if (!at) {
    return
  }
  for (let i = 0; i < GLASS_SPARKS; i++) {
    s.fx.spark(at.x, at.y, at.z)
  }
  play(s, 'bottle', { x: at.x, z: at.z }, GLASS_SOUND_GAIN)
}
