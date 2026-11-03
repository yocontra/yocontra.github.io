// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
/**
 * Run ElevenLabs generations from `manifest.ts` through the Apparish generators.
 *
 *   APPARISH_CARD_SPEND="<why>" bun tools/audio/generate.ts <id> [<id>…] [--take 2] [--force]
 *
 * - Writes raw takes to `tools/audio/raw/<id>.mp3` (or `<id>.t2.mp3` for `--take 2`). The raw folder
 *   is not committed.
 * - Skips takes that already exist unless `--force`, so a rerun never pays twice.
 * - Keys stay in the Apparish env; nothing here reads or prints them.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GENS } from './manifest.ts'

const APPARISH = '/Users/contra/Projects/apparish'
const RAW = resolve(import.meta.dir, 'raw')
const PRELOAD = resolve(import.meta.dir, 'eleven-preload.ts')
const CONCURRENCY = 3
const STATUS = /✓|✗|Error|error|cost|\$/u

async function one(id: string, take: number, force: boolean): Promise<boolean> {
  const g = GENS.find((x) => x.id === id)
  if (!g) {
    console.error(`unknown id ${id}`)
    return false
  }
  const out = join(RAW, take > 1 ? `${id}.t${take}.mp3` : `${id}.mp3`)
  if (existsSync(out) && !force) {
    console.log(`skip ${id} (have ${out})`)
    return true
  }
  const script =
    g.kind === 'music'
      ? 'mobile/scripts/generate-music.ts'
      : 'mobile/scripts/generate-sound-effect.ts'
  const args = [script, out, String(g.seconds), g.prompt, ...(g.loop ? ['--loop'] : [])]
  const p = Bun.spawn(['bun', '--preload', PRELOAD, ...args], {
    cwd: APPARISH,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [so, se, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  const ok = code === 0 && existsSync(out)
  // Only our own status lines: never echo the whole env-bearing output.
  const lines = `${so}\n${se}`.split('\n').filter((l) => STATUS.test(l))
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${id}${take > 1 ? ` t${take}` : ''} ${lines.join(' | ').slice(0, 300)}`,
  )
  return ok
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const ti = argv.indexOf('--take')
  const take = ti >= 0 ? Number(argv[ti + 1]) : 1
  const ids = argv.filter((a, i) => !(a.startsWith('--') || (ti >= 0 && i === ti + 1)))
  if (!process.env.APPARISH_CARD_SPEND) {
    console.error('Set APPARISH_CARD_SPEND to the approved reason first.')
    process.exit(1)
  }
  mkdirSync(RAW, { recursive: true })
  // ElevenLabs answers 429 above a few concurrent requests, so run at most CONCURRENCY at once.
  const queue = [...ids]
  const results: boolean[] = []
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      // biome-ignore lint/performance/noAwaitInLoops: each worker runs its share one at a time on purpose (rate limit)
      results.push(await one(id, take, force))
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  if (results.some((r) => !r)) {
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
