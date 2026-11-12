// The full gate (pre-push, CI, deploy). Stages are independent, so they run side by side while the
// test suite, dominated by real-time Durable Object waits, runs throughout. Every stage always runs.

import { spawn } from 'bun'

/** Each inner list runs in order; `tsc --noEmit` reads the `.astro/types.d.ts` that `astro check` writes. */
const STAGES: string[][][] = [
  [['bun', 'run', 'test']],
  [['biome', 'ci', '--error-on-warnings', '.']],
  [
    ['bun', '--bun', 'astro', 'check'],
    ['tsc', '--noEmit'],
  ],
  [['tsc', '-p', 'api']],
  [['tsc', '-p', 'scripts']],
  [['tsc', '-p', 'tests']],
  [['tsc', '-p', 'tools']],
  [['bun', 'run', 'debt']],
  [['bun', 'scripts/no-js.ts']],
  [['bun', 'tools/check-item-thumbs.ts']],
]
/** Static stages share a few cores; the test workers keep the rest. */
const STATIC_CONCURRENCY = 3

const env = { ...process.env, PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}` }
const started = performance.now()
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)}s`

async function run(commands: string[][]): Promise<boolean> {
  for (const command of commands) {
    const since = performance.now()
    const child = spawn(command, { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const label = command.join(' ')
    if (code !== 0) {
      process.stdout.write(`\n✗ ${label} (${seconds(since)})\n${stdout}${stderr}\n`)
      return false
    }
    process.stdout.write(`✓ ${label} (${seconds(since)})\n`)
  }
  return true
}

const [tests, ...rest] = STAGES
const queue = [...rest]
const pool = Array.from({ length: STATIC_CONCURRENCY }, async () => {
  const results: boolean[] = []
  for (let stage = queue.shift(); stage; stage = queue.shift()) {
    results.push(await run(stage))
  }
  return results
})
const results = (await Promise.all([run(tests ?? []), ...pool])).flat()
const failed = results.filter((ok) => !ok).length
process.stdout.write(
  `\n${failed ? `${failed} check stage(s) failed` : 'All checks passed'} in ${seconds(started)}\n`,
)
process.exit(failed ? 1 : 0)
