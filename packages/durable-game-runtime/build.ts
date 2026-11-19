import { execFileSync } from 'node:child_process'
import { copyFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const directory = new URL('.', import.meta.url)
await rm(new URL('dist', directory), { recursive: true, force: true })
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc')], {
  cwd: directory,
  stdio: 'inherit',
})

const vendorFiles = [
  'ammo.wasm.wasm',
  'physics-callback.wasm',
  'AMMO-LICENSE.txt',
  'PLAYCANVAS-LICENSE.txt',
]
await Promise.all(
  vendorFiles.map((name) =>
    copyFile(new URL(`src/vendor/${name}`, directory), new URL(`dist/vendor/${name}`, directory)),
  ),
)
