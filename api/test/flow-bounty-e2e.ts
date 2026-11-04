/**
 * Flow: Bounty Hunt's way round, against the real Worker and site. Licensed and signed in: hub →
 * queue → a duel (a ghost or a Town Outlaw when nobody else is queued); the receipt's "Next duel"
 * is one tap back into a live search (no saloon, no tile); Rematch, when the room offers it, is one
 * tap back to the street; leaving the queue is one tap to the saloon.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8840 --inspector-port 9280 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8840 bun --bun astro dev --port 4400 --ignore-lock
 *   bun api/test/flow-bounty-e2e.ts --site http://localhost:4400
 *
 * Not part of `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/style/noPlaywrightWaitForSelector: the harness waits on the game's own DOM
import type { Page } from 'playwright'
import {
  check,
  checkTaps,
  duel,
  finish,
  inPage,
  openFlow,
  resetTaps,
  SITE,
  shot,
  toHub,
} from './flow-harness.ts'
import { openLocalD1 } from './local-d1.ts'

const db = openLocalD1()
const f = await openFlow()
const { page } = f
await page.goto(`${SITE}/experiments/out-west/`)
await page.evaluate(() => localStorage.clear())
await toHub(page)
const rider = `Hunt ${Date.now().toString(36).slice(-5)}`
const up = await inPage<{ ok: boolean }>(
  page,
  'net/auth.ts',
  `return await m.signUp(${JSON.stringify(rider)})`,
)
check('signed up', up.ok, up)
const acct = db.query('SELECT id FROM accounts WHERE name = ?').get(rider) as { id: string }
db.query('UPDATE profiles SET gauntlet_clears = 7 WHERE account_id = ?').run(acct.id)
await toHub(page)

/** From a live queue: take the ghost as soon as it's offered, then play the duel out. */
async function matchAndDuel(p: Page): Promise<void> {
  const ghost = p.locator('.ow-queue .ow-btn-primary:not([hidden])')
  await ghost.first().waitFor({ timeout: 30_000 })
  await ghost.first().click()
  await p.waitForSelector('.ow-hub:not(.on)', { state: 'attached', timeout: 30_000 })
  await duel(p, { reactMs: 170 })
  await p.waitForSelector('.ow-results', { timeout: 45_000 })
}

console.log('\n1. Hub → the queue → a duel')
await resetTaps(page)
await page.locator('.ow-tile-bounty').click()
await page.waitForSelector('.ow-queue')
await checkTaps(page, 'hub → searching', 1)
await matchAndDuel(page)
await shot(page, 'bounty-receipt')

console.log('\n2. The receipt → the next duel')
await resetTaps(page)
await page.locator('.ow-results .ow-btn', { hasText: /Next/u }).click()
await page.waitForSelector('.ow-queue', { timeout: 5000 })
await checkTaps(page, 'receipt → searching again', 1)
await matchAndDuel(page)

console.log('\n3. Rematch')
const rematch = page.locator('.ow-results-rematch:not([hidden])')
if ((await rematch.count()) > 0 && (await rematch.isEnabled())) {
  await resetTaps(page)
  await rematch.click()
  await page.waitForSelector('.ow-results', { state: 'detached', timeout: 20_000 })
  await checkTaps(page, 'receipt → the rematch', 1)
  await duel(page, { reactMs: 170 })
  await page.waitForSelector('.ow-results', { timeout: 45_000 })
} else {
  console.log('  · this room offered no rematch (a ghost or Town Outlaw room may not)')
}

console.log('\n4. Leave')
await resetTaps(page)
await page.locator('.ow-results .ow-btn', { hasText: /Next/u }).click()
await page.waitForSelector('.ow-queue')
await page.locator('.ow-queue .ow-btn').first().click()
await page.waitForSelector('.ow-queue', { state: 'detached' })
check('back in the saloon', (await page.locator('.ow-hub.on').count()) === 1)
await checkTaps(page, 'receipt → queue → leave to the saloon', 2)
await finish(f)
