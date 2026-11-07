/** Fine scroll cuts on presentation revolvers; merged into the normal gun draw. */
import type { BufferGeometry } from 'three'
import { type Finish, sweep } from './gunsmith.ts'

const CUT: Finish = { band: 4, rgb: [0.13, 0.11, 0.09], rough: 0.5, metal: 0.6 }

export function scrollEngraving(): BufferGeometry[] {
  const parts: BufferGeometry[] = []
  for (const side of [-1, 1]) {
    // Two open scrolls on the recoil shield. The lines stay shallow, like a chased metal cut.
    for (const cy of [-0.021, -0.006]) {
      const line: [number, number, number][] = []
      for (let i = 0; i <= 28; i++) {
        const a = (i / 28) * Math.PI * 2.8
        const r = 0.007 * (1 - (i / 28) * 0.8)
        const x = -0.05 + Math.cos(a) * r * 0.5
        const z = (0.0172 + ((x + 0.0468) / -0.0067) * (0.0131 - 0.0172)) * side
        line.push([x, cy + Math.sin(a) * r, z])
      }
      parts.push(sweep(line, 0.000_32, CUT, { radial: 3, segments: 30 }))
    }
    // Chased vines along the barrel's side, with small paired leaves.
    const vine: [number, number, number][] = []
    for (let i = 0; i <= 36; i++) {
      const x = 0.027 + (i / 36) * 0.052
      const y = Math.sin((i / 36) * Math.PI * 3) * 0.0028
      vine.push([x, y, Math.sqrt(0.0084 ** 2 - y ** 2) * side])
    }
    parts.push(sweep(vine, 0.000_28, CUT, { radial: 3, segments: 40 }))
    for (let j = 1; j <= 5; j++) {
      const x = 0.027 + (j / 6) * 0.052
      parts.push(
        sweep(
          [
            [x - 0.003, 0.001, 0.0084 * side],
            [x, 0.0048, 0.007 * side],
            [x + 0.003, 0.001, 0.0084 * side],
          ],
          0.000_25,
          CUT,
          { radial: 3, segments: 8 },
        ),
      )
    }
  }
  return parts
}
