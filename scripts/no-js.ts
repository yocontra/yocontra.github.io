// Guardrail: this repo is TypeScript-only. Fails if any hand-written JS is tracked.
import { spawnSync } from 'bun'

const JS_FILE = /\.(?:c|m)?js$/u

/** The one hand-written JS file we ship: the Out West service worker. */
const ALLOWED = new Set(['public/experiments/out-west/sw.js'])

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
