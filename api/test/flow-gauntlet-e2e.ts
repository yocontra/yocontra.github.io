/**
 * Flow: Quick Draw (practice and ranked) and the licence road, against the real Worker and site.
 *
 * 1. Practice: a loss retries on its own with no poster and no tap; a win moves on with no tap;
 *    Pause → Saloon is two taps; the Quick Draw sheet leads with the choice made last time.
 * 2. The licence road: signed up with no licence, Frontier's gate offers the ranked gauntlet; after
 *    the third outlaw falls the duel offers Frontier, and one tap there lands in Frontier (the
 *    saloon carries on once the server shows the licence), with no trip back through the tiles.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8840 --inspector-port 9280 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8840 bun --bun astro dev --port 4400 --ignore-lock
 *   bun api/test/flow-gauntlet-e2e.ts --site http://localhost:4400
 *
 * Not part of `bun test`.
 */
// biome-ignore-all lint/style/noPlaywrightWaitForSelector: the harness waits on the game's own DOM
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
  sleep,
  toHub,
} from './flow-harness.ts'
import { openLocalD1 } from './local-d1.ts'

const db = openLocalD1()
const f = await openFlow()
const { page } = f
await page.goto(`${SITE}/experiments/out-west/`)
await page.evaluate(() => {
  localStorage.clear()
  sessionStorage.clear()
})
await toHub(page)

console.log('\n1. Practice: loss, retry, win, saloon')
await resetTaps(page)
await page.locator('.ow-tile-gauntlet').click()
await page.locator('.ow-choice', { hasText: 'Practice' }).last().click()
await checkTaps(page, 'hub → a practice duel', 2)
// lose on purpose: far too slow
await duel(page, { reactMs: 2500 })
await page.waitForSelector('.ow-card-lose.on', { timeout: 20_000 })
await resetTaps(page)
await page
  .waitForSelector('.ow-card-lose.on', { state: 'detached', timeout: 10_000 })
  .catch(() => null)
await page.waitForFunction("!document.querySelector('.ow-card.on')", null, { timeout: 10_000 })
await checkTaps(page, 'loss → the retry (on its own)', 0)
await duel(page, { reactMs: 180 })
await page.waitForSelector('.ow-card-win.on', { timeout: 20_000 })
await resetTaps(page)
await page.waitForFunction("!document.querySelector('.ow-card-win.on')", null, { timeout: 15_000 })
await checkTaps(page, 'win → the next outlaw (on its own)', 0)
await sleep(1500)
// skip a Gazette page if one is up (one key)
if (await page.locator('.ow-gz.on').count()) {
  await sleep(1000)
  await page.keyboard.press('Space')
}
await resetTaps(page)
await page.locator('.ow-pause').click()
await page.locator('.ow-menu .ow-btn', { hasText: 'Quit' }).click()
await page.waitForSelector('.ow-hub.on')
await checkTaps(page, 'pause → saloon', 2)
await page.locator('.ow-tile-gauntlet').click()
const lead = (await page.locator('.ow-choice.primary b').textContent()) ?? ''
check(
  'the Quick Draw sheet leads with Practice (the last choice)',
  lead.startsWith('Practice'),
  lead,
)
await shot(page, 'quickdraw-remembered')
await page.keyboard.press('Escape')
check('Escape closes the Quick Draw sheet', (await page.locator('.ow-choice').count()) === 0)

console.log('\n2. The licence road to Frontier')
const rider = `Road ${Date.now().toString(36).slice(-5)}`
const up = await inPage<{ ok: boolean }>(
  page,
  'net/auth.ts',
  `return await m.signUp(${JSON.stringify(rider)})`,
)
check('signed up', up.ok, up)
const acct = db.query('SELECT id FROM accounts WHERE name = ?').get(rider) as { id: string }
db.query('UPDATE profiles SET gauntlet_clears = 0 WHERE account_id = ?').run(acct.id)
await toHub(page)
await resetTaps(page)
await page.locator('.ow-tile-frontier').click()
await page.locator('.ow-feat-gate .ow-btn-primary').click()
await page.waitForSelector('.ow-hub:not(.on)', { state: 'attached' })
await checkTaps(page, 'Frontier gate → a ranked run', 2)
for (let i = 0; i < 3; i++) {
  await duel(page, { reactMs: 170 })
  await page.waitForSelector('.ow-card-win.on', { timeout: 30_000 })
  if (i < 2) {
    await page.waitForFunction("!document.querySelector('.ow-card-win.on')", null, {
      timeout: 15_000,
    })
    await sleep(1200)
    if (await page.locator('.ow-gz.on').count()) {
      await sleep(1000)
      await page.keyboard.press('Space')
    }
  }
}
const offer = page.locator('.ow-sheet .ow-btn-primary', { hasText: 'Frontier' })
await offer.waitFor({ timeout: 20_000 })
check('after outlaw 3 the duel offers Frontier', true)
await shot(page, 'licence-offer')
await resetTaps(page)
await offer.click()
// counted before the page changes (a new page starts its own count)
await checkTaps(page, 'licence earned → Frontier', 1)
await page.waitForURL(/\/frontier\//u, { timeout: 30_000 })
check('and that tap lands in Frontier', true)
const clears = db
  .query('SELECT gauntlet_clears AS c FROM profiles WHERE account_id = ?')
  .get(acct.id) as { c: number }
check('the server holds the licence', (clears.c & 7) === 7, clears)
await finish(f)
