/**
 * One-time production setup for the out-west API. Run it locally after `bunx wrangler login`:
 *
 *   bun scripts/release.ts
 *
 * It is idempotent: each step checks before acting.
 *   1. Creates the production D1 database (if `api/wrangler.jsonc` still has the placeholder id) and
 *      writes the real id into the config.
 *   2. Applies every migration to the remote database.
 *   3. Sets the Worker secrets: a freshly generated AUTH_SECRET, and the Turnstile secret you paste.
 *   4. Deploys the Worker to api.contra.io.
 * See RELEASE.md for the surrounding steps (DNS, Turnstile site, GitHub variables).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'bun'

const CONFIG = 'api/wrangler.jsonc'
const DB_NAME = 'contra-leaderboard'
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000'
const UUID = /(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u

function wrangler(args: string[], input?: string): string {
  const proc = spawnSync(['bunx', 'wrangler', ...args], {
    stdin: input === undefined ? 'inherit' : new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const out = proc.stdout.toString()
  if (proc.exitCode !== 0) {
    console.error(out)
    throw new Error(`wrangler ${args.join(' ')} failed`)
  }
  return out
}

function ensureDatabase(): void {
  const config = readFileSync(CONFIG, 'utf8')
  if (!config.includes(PLACEHOLDER)) {
    console.log('D1: production database id already set')
    return
  }
  const listed = wrangler(['d1', 'list', '--json'])
  const existing = (JSON.parse(listed) as { name: string; uuid: string }[]).find(
    (db) => db.name === DB_NAME,
  )
  const id = existing?.uuid ?? UUID.exec(wrangler(['d1', 'create', DB_NAME]))?.groups?.id
  if (!id) {
    throw new Error('Could not determine the D1 database id')
  }
  writeFileSync(CONFIG, config.replace(PLACEHOLDER, id))
  console.log(`D1: using ${id} (written to ${CONFIG}; commit this change)`)
}

/** One line from the terminal (Bun's `console` iterates stdin lines). */
async function ask(question: string): Promise<string> {
  process.stdout.write(`${question} `)
  for await (const line of console) {
    return line.trim()
  }
  return ''
}

async function required(question: string): Promise<string> {
  const answer = await ask(question)
  if (!answer) {
    throw new Error(`${question} is required`)
  }
  return answer
}

async function setSecrets(): Promise<void> {
  const authSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url')
  wrangler(['secret', 'put', 'AUTH_SECRET', '--config', CONFIG], authSecret)
  console.log('Secret: AUTH_SECRET set (generated)')
  const turnstile = await required('Turnstile secret key for contra.io:')
  wrangler(['secret', 'put', 'TURNSTILE_SECRET', '--config', CONFIG], turnstile)
  console.log('Secret: TURNSTILE_SECRET set')
}

wrangler(['whoami'])
ensureDatabase()
wrangler(['d1', 'migrations', 'apply', DB_NAME, '--config', CONFIG, '--remote'])
console.log('D1: migrations applied')
if (/^y(?:es)?$/iu.test(await ask('Set (or rotate) the Worker secrets now? [y/N]'))) {
  await setSecrets()
}
wrangler(['deploy', '--config', CONFIG])
console.log('Deployed. Next: finish the remaining steps in RELEASE.md.')
