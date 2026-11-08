// Guardrail: this repo is TypeScript-only. Fails if any hand-written JS is tracked.

import { createHash } from 'node:crypto'
import { spawnSync } from 'bun'

const JS_FILE = /\.(?:c|m)?js$/u

/** The only authored JavaScript is the service worker; decoder exceptions are byte-pinned below. */
const ALLOWED = new Set(['public/experiments/out-west/sw.js'])
const VENDOR = {
  'public/experiments/out-west/vendor/basis/2.23.3/basis.js':
    'c85407f23254399027517c51dc129e49f3e4abec47450c8f144b2007f64565e9',
  'public/experiments/out-west/vendor/basis/2.23.3/basis.wasm.js':
    '82143c2193310331a3186530cc1615950f5ddd4d308aa6a25d82ad1d5933c624',
  'public/experiments/out-west/vendor/basis/2.23.3/basis.wasm.wasm':
    '70ed1e72dea7132706ee4e8637d9fc1e348ea03bb3a46644372f309067c47eef',
}
for (const [path, expected] of Object.entries(VENDOR)) {
  const hash = createHash('sha256')
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest('hex')
  if (hash !== expected) {
    throw new Error(`Vendored decoder differs from PlayCanvas v2.23.3: ${path}`)
  }
  ALLOWED.add(path)
}

const proc = spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard'])
const offenders = proc.stdout
  .toString()
  .split('\n')
  .filter((file) => JS_FILE.test(file) && !ALLOWED.has(file))

if (offenders.length > 0) {
  console.error(`JavaScript files are not allowed:\n${offenders.map((f) => `  ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('no-js: ok')
