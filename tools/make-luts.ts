#!/usr/bin/env bun
/**
 * Export the in-game time-of-day looks (engine/lut.ts LOOKS) as 32³ `.cube`
 * files, so a colourist can open them in Resolve or Photoshop, grade on top
 * of in-game captures, and hand back an authored `.cube`. The game can load
 * an authored cube with `lutFromCube()` in engine/lut.ts.
 *
 *   bun tools/make-luts.ts <out_dir>
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyLook, LOOKS, LUT_SIZE } from '../src/experiments/out-west/engine/lut.ts'

async function main(): Promise<void> {
  const out = process.argv[2]
  if (!out) {
    throw new Error('usage: bun tools/make-luts.ts <out_dir>')
  }
  await mkdir(out, { recursive: true })
  const n = LUT_SIZE
  await Promise.all(
    LOOKS.map(async (look) => {
      const lines = [`TITLE "out west day ${look.at}"`, `LUT_3D_SIZE ${n}`, '']
      // .cube order: red fastest, then green, then blue
      for (let b = 0; b < n; b++) {
        for (let g = 0; g < n; g++) {
          for (let r = 0; r < n; r++) {
            const c = applyLook(look, r / (n - 1), g / (n - 1), b / (n - 1))
            lines.push(c.map((v) => v.toFixed(6)).join(' '))
          }
        }
      }
      const file = join(out, `day-${look.at.toFixed(2)}.cube`)
      await writeFile(file, `${lines.join('\n')}\n`)
      console.log(file)
    }),
  )
}

await main()
