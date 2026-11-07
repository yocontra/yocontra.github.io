/** Rebuild the small strict-FP kernel; the application build consumes the checked-in bytes. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const source = 'src/experiments/out-west/ffa/scene/ragdoll-gs.c'
const output = source.replace(/\.c$/u, '.wasm')
const clang = process.env.CLANG ?? 'clang'
const result = spawnSync(
  clang,
  [
    '--target=wasm32',
    '-nostdlib',
    '-O3',
    '-ffp-contract=off',
    '-Wl,--no-entry',
    '-Wl,--export=gs',
    '-Wl,--export=gs_abi',
    '-Wl,--export=gs_width',
    '-Wl,--export=gs_base',
    '-Wl,--export-memory',
    '-o',
    output,
    source,
  ],
  { stdio: 'inherit' },
)
if (result.error) {
  throw result.error
}
if (result.status !== 0) {
  throw new Error(`Kernel compiler exited ${result.status}`)
}
process.stdout.write(
  `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${output}\n`,
)
