/**
 * Flow: the Daily Outlaw's retry, as a guest, against the real Worker and site. After each duel
 * the result comes up on the street (never the saloon) with "Try again (N left)" one tap away; a
 * win, a back-shot and a loss all behave the same; with no tries left the result shows your best
 * and Back, one tap to the saloon.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8840 --inspector-port 9280 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8840 bun --bun astro dev --port 4400 --ignore-lock
 *   bun api/test/flow-daily-e2e.ts --site http://localhost:4400
 *
 * Not part of `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/style/noPlaywrightWaitForSelector: the harness waits on the game's own DOM
// biome-ignore-all lint/performance/noAwaitInLoops: the tries run strictly in order
import { DAILY_ATTEMPTS, dayKey } from '../../src/experiments/out-west/data/daily.ts'
import {
  check,
  checkTaps,
  duel,
  finish,
  openFlow,
  resetTaps,
  SITE,
  shot,
  sleep,
  toHub,
} from './flow-harness.ts'
import { openLocalD1 } from './local-d1.ts'

const db = openLocalD1()
// a fresh day for every guest on this machine
db.query('DELETE FROM daily_runs WHERE day = ? AND account_id IS NULL').run(dayKey())

const f = await openFlow()
const { page } = f
await page.goto(`${SITE}/experiments/out-west/`)
await page.evaluate(() => localStorage.clear())
await toHub(page)

console.log('\n1. Hub → the first daily duel')
await resetTaps(page)
await page.locator('.ow-tile-daily').click()
await page.locator('.ow-daily .ow-btn-primary', { hasText: 'Ride out' }).click()
await page.waitForSelector('.ow-hub:not(.on)', { state: 'attached' })
await checkTaps(page, 'hub → riding out', 2)

const result = '.ow-daily-result'
const outcomes: { name: string; early?: boolean; reactMs?: number }[] = [
  { name: 'win', reactMs: 180 },
  { name: 'back-shot', early: true },
  { name: 'loss', reactMs: 1400 },
]
for (const [i, o] of outcomes.entries()) {
  console.log(`\n${i + 2}. Daily try ${i + 1}: a ${o.name}`)
  await duel(page, o)
  await page.waitForSelector(result, { timeout: 30_000 })
  check('the result is on the street, not the saloon', !(await page.locator('.ow-hub.on').count()))
  const left = DAILY_ATTEMPTS - (i + 1)
  if (left > 0) {
    const again = page.locator(`${result} .ow-btn-primary`, { hasText: `Try again (${left} left)` })
    await again.waitFor({ timeout: 15_000 })
    check(`"Try again (${left} left)" is the primary button`, true)
    check(
      'and "Back" beside it',
      (await page.locator(`${result} .ow-btn`, { hasText: 'Back' }).count()) === 1,
    )
    await shot(page, `daily-result-${o.name}`)
    await resetTaps(page)
    await again.click()
    await page.waitForSelector(result, { state: 'detached', timeout: 30_000 })
    check('straight back on the street (no saloon)', !(await page.locator('.ow-hub.on').count()))
    await checkTaps(page, 'result → the next daily duel', 1)
    await sleep(500)
  } else {
    await page.locator(`${result} .ow-daily-terms`, { hasText: 'No tries left' }).waitFor()
    check(
      'no Try again with no tries left',
      (await page.locator(`${result} .ow-btn`, { hasText: 'Try again' }).count()) === 0,
    )
    const terms = (await page.locator(`${result} .ow-daily-terms`).textContent()) ?? ''
    check('your best is shown', terms.includes('your best'), terms)
    await shot(page, 'daily-result-done')
    await resetTaps(page)
    await page.locator(`${result} .ow-btn-primary`, { hasText: 'Back' }).click()
    await page.waitForSelector('.ow-hub.on')
    await checkTaps(page, 'result → the saloon', 1)
  }
}

const runs = db
  .query('SELECT outcome FROM daily_runs WHERE day = ? AND account_id IS NULL ORDER BY created_at')
  .all(dayKey()) as { outcome: string | null }[]
check(
  'the server judged all three tries (win, coward, loss)',
  runs.map((r) => r.outcome).join(',') === 'win,coward,loss',
  runs,
)
await finish(f)
