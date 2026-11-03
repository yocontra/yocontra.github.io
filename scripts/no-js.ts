// Guardrail: this repo is TypeScript-only. Fails if any hand-written JS is tracked.
const proc = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard'])
const offenders = proc.stdout
  .toString()
  .split('\n')
  .filter((file) => /\.(c|m)?js$/.test(file) && !file.startsWith('public/'))

if (offenders.length > 0) {
  console.error(`JavaScript files are not allowed:\n${offenders.map((f) => `  ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('no-js: ok')
