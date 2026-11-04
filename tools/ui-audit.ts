// biome-ignore-all lint/style/noExcessiveLinesPerFile: one CLI walk through every screen, read top to bottom
// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear audit script
// biome-ignore-all lint/performance/noAwaitInLoops: one page, one screen at a time
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: sheets fetch and settle; the waits are deliberate
// biome-ignore-all lint/suspicious/noConsole: a CLI report
/**
 * UI layout audit for out west, in real Chrome against a running dev server (and, for the
 * signed-in screens, a local API with its D1).
 *
 *   bun run dev --port 4371                       # PUBLIC_API_URL=http://localhost:8811
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8811 ...
 *   bun tools/ui-audit.ts [baseUrl] [--api=http://localhost:8811] [--size=375x812,...]
 *     [--screen=substring] [--shots=label] [--json] [--guest]
 *
 * For every screen at every size it runs `ui-audit/probe.ts` in the page: text overflowing its
 * box, text clipped by an ancestor or the screen edge, ellipses on short text, overlapping text,
 * tap targets under 44 px (touch sizes; 24 px with a mouse), interactive controls not set in a
 * game face, and dead primary buttons on results receipts. Screens reached by playing are played
 * (title, hub, every sheet, the Outfitter's tabs, the queue, the Frontier practice town); the rest
 * are mounted from `ui-audit/fixtures.ts` with worst-case data. Signed-in state is set up
 * directly: a passkey account on a CDP virtual authenticator, then SQL on the local D1 (`--api`
 * must be local). `--shots=label` saves `.playwright-mcp/ui-<label>-<size>-<screen>.png`.
 * Exit code 1 when anything is found.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// biome-ignore lint/correctness/noUnresolvedImports: playwright re-exports these types from playwright-core
import type { Browser, BrowserContext, Page } from 'playwright'
import { CATALOG } from '../src/experiments/out-west/data/catalog.ts'
import { xpForLevel } from '../src/experiments/out-west/data/progression.ts'
import type * as Auth from '../src/experiments/out-west/net/auth.ts'
import type * as Profile from '../src/experiments/out-west/ui/profile.ts'
import type * as Fx from './ui-audit/fixtures.ts'
import { type Finding, type ProbeArgs, probe } from './ui-audit/probe.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4371'
const arg = (k: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
const api = arg('api') ?? 'http://localhost:8811'
const only = arg('screen')
const shots = arg('shots')
const json = process.argv.includes('--json')
const guestOnly = process.argv.includes('--guest')

interface Size {
  name: string
  width: number
  height: number
  touch: boolean
  dpr: number
}
const SIZES: Size[] = [
  { name: '375x812', width: 375, height: 812, touch: true, dpr: 3 },
  { name: '812x375', width: 812, height: 375, touch: true, dpr: 3 },
  { name: '390x844', width: 390, height: 844, touch: true, dpr: 3 },
  { name: '360x740', width: 360, height: 740, touch: true, dpr: 3 },
  { name: '1440x900', width: 1440, height: 900, touch: false, dpr: 1 },
]
const sizeArg = arg('size')
const sizes = sizeArg ? SIZES.filter((s) => sizeArg.split(',').includes(s.name)) : SIZES

const FONTS = ['Ultra', 'Rye', 'EB Garamond Variable', 'Oswald Variable']
const SKIP = ['.fr-feed', 'astro-dev-toolbar', '.ow-debug', '.fr-load']
const GAME = `${base}/experiments/out-west/`
const FRONTIER = `${base}/experiments/out-west/frontier/?server=loopback&bots=6`
const FIXTURES = '/tools/ui-audit/fixtures.ts'
/** The account the signed-in screens run as (16 wide capitals: the server's longest). */
/** Six fixed wide capitals and ten random ones (1,024 names); a taken one is drawn again. */
const wideName = (): string =>
  `WMWMWM${Array.from({ length: 10 }, () => 'WM'[Math.round(Math.random())]).join('')}`
let Name = wideName()

interface Row {
  size: string
  screen: string
  findings: Finding[]
}
const rows: Row[] = []

const want = (screen: string): boolean => only === null || screen.includes(only)

// biome-ignore lint/complexity/useMaxParams: page, size and screen, plus what to probe
async function audit(
  page: Page,
  size: Size,
  screen: string,
  scope: string,
  o: { last?: boolean; deadPrimary?: string } = {},
): Promise<void> {
  if (!want(screen)) {
    return
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined), undefined)
  await page.waitForTimeout(350)
  const args: ProbeArgs = {
    scope,
    last: o.last ?? false,
    tap: size.touch ? 44 : 24,
    skip: SKIP,
    fonts: FONTS,
    shortText: 24,
    deadPrimary: o.deadPrimary ?? null,
  }
  const findings = await page.evaluate(probe, args)
  rows.push({ size: size.name, screen, findings })
  if (shots) {
    mkdirSync('.playwright-mcp', { recursive: true })
    await page.screenshot({ path: `.playwright-mcp/ui-${shots}-${size.name}-${screen}.png` })
  }
  if (!json) {
    const mark = findings.length === 0 ? 'ok  ' : `${String(findings.length).padEnd(4)}`
    console.log(`${mark}${size.name.padEnd(9)} ${screen}`)
  }
}

/** Run a fixture export in the page (the dev server serves `tools/ui-audit/fixtures.ts`). */
async function fixture(page: Page, call: (m: typeof Fx) => string): Promise<string> {
  return await page.evaluate(
    async ({ src, url }) => {
      const m = (await import(/* @vite-ignore */ url)) as typeof Fx
      // biome-ignore lint/security/noGlobalEval: the caller's arrow, rebuilt in the page's global scope
      const indirect = globalThis.eval
      const fn = indirect(`(${src})`) as (mod: typeof Fx) => string
      return fn(m)
    },
    { src: call.toString(), url: FIXTURES },
  )
}

const TOP_SHEET = '.ow-sheet.on'
const OFF_SCREEN = /outside of the viewport/u
const TAKEN = /spoken for|taken/iu
const COVERED = /intercepts pointer events/u
const AUTH = '/src/experiments/out-west/net/auth.ts'
const PROFILE = '/src/experiments/out-west/ui/profile.ts'

/** Close the open sheets: Escape, then a tap on the backdrop for any that ignore it. */
async function closeSheets(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  for (let i = 0; i < 4 && (await page.locator(TOP_SHEET).count()) > 0; i++) {
    // biome-ignore lint/suspicious/noPlaywrightForceOption: a tap on the backdrop's corner, under nothing
    await page
      .locator(TOP_SHEET)
      .last()
      .click({ position: { x: 3, y: 3 }, force: true })
    await page.waitForTimeout(150)
  }
}

async function tap(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().click({ timeout: 6000 })
  await page.waitForTimeout(250)
}

/**
 * One step of the walk. A step that fails (a control off screen or covered, a sheet that never
 * opened) is a finding too; the walk tidies up and carries on.
 */
async function step(
  page: Page,
  size: Size,
  screen: string,
  run: () => Promise<void>,
): Promise<void> {
  if (!want(screen)) {
    return
  }
  try {
    await run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    let why = msg.split('\n')[0] ?? msg
    if (OFF_SCREEN.test(msg)) {
      why = 'control is outside the viewport'
    } else if (COVERED.test(msg)) {
      why = 'control is covered by another element'
    }
    rows.push({
      size: size.name,
      screen,
      findings: [{ kind: 'scope', el: screen, text: '', detail: `could not reach: ${why}` }],
    })
    if (!json) {
      console.log(`ERR ${size.name.padEnd(9)} ${screen}: ${why}`)
    }
    await closeSheets(page).catch(() => undefined)
    if ((await page.locator('.ow-store.on').count()) > 0) {
      // biome-ignore lint/suspicious/noPlaywrightForceOption: tidying up after a failed step
      await page
        .locator('.ow-store-head .ow-btn')
        .click({ force: true })
        .catch(() => undefined)
    }
  }
}

/** The title, then into the saloon. */
async function toHub(page: Page, size: Size, title: boolean): Promise<void> {
  await page.goto(GAME)
  await page.locator('.ow-title.ready').waitFor({ timeout: 120_000 })
  if (title) {
    await audit(page, size, 'title', '.ow-title')
    await tap(page, '.ow-credits-btn')
    await audit(page, size, 'credits', '.ow-credits')
    await tap(page, '.ow-credits-btn')
  }
  await page.locator('.ow-start').click()
  await page.locator('.ow-hub.on').waitFor({ timeout: 60_000 })
  await page.waitForTimeout(1200)
}

const HUB_LINK = (i: number): string => `.ow-hub-links .ow-btn >> nth=${i}`

/** The Outfitter: every tab, an item picked, and (signed in) a dye job. */
async function store(page: Page, size: Size, who: string): Promise<void> {
  await tap(page, '.ow-tile-store')
  await page.locator('.ow-store.on').waitFor()
  await page.waitForTimeout(600)
  const tabs = await page.locator('.ow-store-tab').count()
  for (let i = 0; i < tabs; i++) {
    await page.locator('.ow-store-tab').nth(i).click()
    await audit(page, size, `store-${who}-tab${i}`, '.ow-store')
  }
  await page.locator('.ow-store-tab').first().click()
  await page.locator('.ow-item').nth(1).click()
  await audit(page, size, `store-${who}-item`, '.ow-store')
  if (who === 'member') {
    const items = await page.locator('.ow-item').count()
    for (let i = 0; i < items; i++) {
      await page.locator('.ow-item').nth(i).click()
      if ((await page.locator('.ow-feat-dye').count()) > 0) {
        await page.locator('.ow-feat-swatch').nth(3).click()
        await audit(page, size, 'store-dye', '.ow-store')
        break
      }
    }
  }
  await tap(page, '.ow-store-head .ow-btn')
  await page.waitForTimeout(400)
}

/** The leaderboard, both tabs. */
async function board(page: Page, size: Size): Promise<void> {
  await tap(page, HUB_LINK(0))
  await page.locator('.ow-board.on').waitFor()
  await page.waitForTimeout(800)
  const tabs = page.locator('.ow-feat-board-tabs .ow-store-tab')
  for (let i = 0; i < (await tabs.count()); i++) {
    await tabs.nth(i).click()
    await page.waitForTimeout(800)
    await audit(page, size, `leaderboard-tab${i}`, '.ow-board.on')
  }
  await closeSheets(page)
}

async function sheet(page: Page, size: Size, screen: string, open: string): Promise<void> {
  await step(page, size, screen, async () => {
    await tap(page, open)
    await page.waitForTimeout(700)
    await audit(page, size, screen, TOP_SHEET, { last: true })
    await closeSheets(page)
  })
}

/** Fixture screens: the duel HUD, card, pause, end ledger, match intro and every receipt. */
async function duelFixtures(page: Page, size: Size): Promise<void> {
  const one = async (screen: string, call: (m: typeof Fx) => string, dead = false) => {
    if (!want(screen)) {
      return
    }
    const scope = await fixture(page, call)
    await page.waitForTimeout(400)
    await audit(page, size, screen, scope, dead ? { deadPrimary: '.ow-results' } : {})
  }
  await one('duel-hud', (m) => m.duelHudIdle())
  await one('duel-call', (m) => m.duelHudCall())
  await one('duel-card', (m) => m.duelCard())
  await one('duel-pause', (m) => m.pause())
  await one('gauntlet-ledger', (m) => m.endLedger())
  await one('match-intro', (m) => m.matchIntro(false))
  await one('match-intro-ghost', (m) => m.matchIntro(true))
  const states = await page.evaluate(
    async (url) => ((await import(/* @vite-ignore */ url)) as typeof Fx).RESULT_STATES,
    FIXTURES,
  )
  for (const s of states) {
    // the state name travels inside the arrow's source
    await one(
      `results-${s}`,
      new Function('m', `return m.results(${JSON.stringify(s)})`) as (m: typeof Fx) => string,
      true,
    )
  }
  await fixture(page, (m) => {
    m.clear()
    return ''
  })
}

/** Run SQL on the local D1 behind `--api`. */
function sql(command: string): void {
  // a file: bunx re-splits arguments that contain spaces
  const file = join(tmpdir(), `ui-audit-${process.pid}.sql`)
  writeFileSync(file, command)
  const r = spawnSync(
    'bunx',
    [
      'wrangler',
      'd1',
      'execute',
      'contra-leaderboard',
      '--local',
      '--config',
      'api/wrangler.jsonc',
      `--file=${file}`,
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) {
    throw new Error(`d1: ${r.stderr || r.stdout}`)
  }
}

const accountWhere = (): string => `(SELECT id FROM accounts WHERE name = '${Name}')`

/** Level 12, a modest purse, no licence: the licence gate and a member's first screens. */
function seedFresh(): void {
  sql(
    `UPDATE profiles SET level = 12, xp = ${xpForLevel(12) + 40}, purse = 1800, gauntlet_clears = 0 WHERE account_id = ${accountWhere()}`,
  )
}

/** Level 50, rich, licensed, owns the whole catalog: prestige, dyes, notices. */
function seedVeteran(): void {
  const now = Date.now()
  const items = CATALOG.map((i) => `(${accountWhere()}, '${i.id}', 'admin', ${now})`).join(', ')
  sql(
    `UPDATE profiles SET level = 50, xp = ${xpForLevel(50)}, purse = 1234567, gauntlet_clears = 131071 WHERE account_id = ${accountWhere()}; INSERT OR IGNORE INTO inventory (account_id, item_id, source, acquired_at) VALUES ${items}`,
  )
}

/** Sign up `NAME` with a virtual passkey (first context only). */
async function signUp(ctx: BrowserContext, page: Page): Promise<void> {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  for (let attempt = 0; ; attempt++) {
    const r = await page.evaluate(
      async ({ who, url }) => {
        const m = (await import(/* @vite-ignore */ url)) as typeof Auth
        return await m.signUp(who)
      },
      { who: Name, url: AUTH },
    )
    if (r.ok) {
      return
    }
    if (!TAKEN.test(r.error) || attempt >= 4) {
      throw new Error(`sign-up failed: ${r.error}`)
    }
    Name = wideName()
  }
}

/** The away report and a closed town, injected into the real responses. */
async function veteranRoutes(page: Page): Promise<void> {
  await page.route(`${api}/me`, async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as Record<string, unknown>
    body.away = {
      since: null,
      asOf: Date.now(),
      royalties: { count: 23, amount: 123_456 },
      mostWanted: [{ month: '2026-10', rank: 1 }],
      total: 125_000,
    }
    await route.fulfill({ response: res, json: body })
  })
  await page.route(`${api}/town/lobbies`, (route) =>
    route.fulfill({ status: 200, json: { open: false, lobbies: [] } }),
  )
}

async function guest(browser: Browser, size: Size): Promise<void> {
  const ctx = await newContext(browser, size, null)
  const page = await ctx.newPage()
  await toHub(page, size, true)
  await audit(page, size, 'hub-guest', '.ow-hub')
  await sheet(page, size, 'gauntlet-sheet', '.ow-tile-gauntlet')
  await sheet(page, size, 'account-guest', HUB_LINK(3))
  await sheet(page, size, 'chalkboard-guest', HUB_LINK(1))
  await sheet(page, size, 'ledger-guest', HUB_LINK(2))
  await step(page, size, 'leaderboard', () => board(page, size))
  await step(page, size, 'store-guest', () => store(page, size, 'guest'))
  await duelFixtures(page, size)
  await ctx.close()
}

type State = Awaited<ReturnType<BrowserContext['storageState']>>

async function member(browser: Browser, size: Size, state: State | null): Promise<State> {
  const ctx = await newContext(browser, size, state)
  const page = await ctx.newPage()
  if (state === null) {
    await page.goto(GAME)
    await page.locator('.ow-title.ready').waitFor({ timeout: 120_000 })
    await signUp(ctx, page)
  }
  seedFresh()
  await toHub(page, size, false)
  await page.locator('.ow-hub-nums').waitFor({ timeout: 15_000 })
  // the first visit is the notices' baseline
  await closeSheets(page)
  await audit(page, size, 'hub', '.ow-hub')
  await sheet(page, size, 'licence', '.ow-tile-frontier')
  await sheet(page, size, 'account', HUB_LINK(3))
  await step(page, size, 'account-delete', async () => {
    await tap(page, HUB_LINK(3))
    await page.waitForTimeout(800)
    await tap(page, '.ow-acct-btn.danger')
    await audit(page, size, 'account-delete', TOP_SHEET, { last: true })
    await closeSheets(page)
  })
  await sheet(page, size, 'ledger', HUB_LINK(2))
  await sheet(page, size, 'chalkboard', HUB_LINK(1))
  if (want('profile') || want('report')) {
    for (const [screen, fn] of [
      ['profile', 'openProfile'],
      ['report', 'reportSheet'],
    ] as const) {
      await page.evaluate(
        async ({ who, open, url }) => {
          const m = (await import(/* @vite-ignore */ url)) as typeof Profile
          const root = document.querySelector<HTMLElement>('#ow')
          if (root) {
            m[open](root, who)
          }
        },
        { who: Name, open: fn, url: PROFILE },
      )
      await page.waitForTimeout(1200)
      await audit(page, size, screen, TOP_SHEET, { last: true })
      await closeSheets(page)
    }
  }
  await step(page, size, 'queue', async () => {
    await tap(page, '.ow-tile-bounty')
    await page.waitForTimeout(1500)
    await audit(page, size, 'queue', '.ow-queue')
    // "Duel a ghost now" shows at 8 s
    await page.waitForTimeout(8000)
    await audit(page, size, 'queue-ghost', '.ow-queue')
    await tap(page, '.ow-queue .ow-btn')
  })
  // the veteran: level 50, the whole catalog, an away report, a closed town
  seedVeteran()
  await veteranRoutes(page)
  await toHub(page, size, false)
  await page.waitForTimeout(800)
  if ((await page.locator('.ow-feat-notice').count()) > 0) {
    await audit(page, size, 'notices', '.ow-feat-notice')
    await tap(page, '.ow-feat-notice .ow-btn-primary')
  } else if (want('notices')) {
    rows.push({
      size: size.name,
      screen: 'notices',
      findings: [{ kind: 'scope', el: '.ow-feat-notice', text: '', detail: 'no notices shown' }],
    })
  }
  await audit(page, size, 'hub-veteran', '.ow-hub')
  await step(page, size, 'prestige', async () => {
    await tap(page, '.ow-feat-prestige')
    await audit(page, size, 'prestige', TOP_SHEET, { last: true })
    await closeSheets(page)
  })
  await sheet(page, size, 'closed', '.ow-tile-frontier')
  await step(page, size, 'store-member', () => store(page, size, 'member'))
  const next = await ctx.storageState()
  await ctx.close()
  return next
}

async function frontier(browser: Browser, size: Size): Promise<void> {
  if (
    ![
      'frontier-howto',
      'frontier-hud',
      'frontier-pause',
      'frontier-score',
      'frontier-busy',
      'frontier-death',
      'frontier-riders',
    ].some(want)
  ) {
    return
  }
  const ctx = await newContext(browser, size, null)
  const page = await ctx.newPage()
  await page.goto(`${FRONTIER}&name=${Name}`)
  await page.locator('.fr-hud').waitFor({ timeout: 120_000 })
  await page.waitForFunction(() => !document.querySelector('.fr-load'), undefined, {
    timeout: 120_000,
  })
  await page.waitForTimeout(1500)
  // the first ride in on a device opens How to play: audit every step, then ride
  await page.locator('.fr-howto:not([hidden])').waitFor({ timeout: 10_000 })
  for (let i = 1; i <= 4; i++) {
    if (want('frontier-howto')) {
      await audit(page, size, 'frontier-howto', '.fr-howto')
    }
    await tap(page, '.fr-howto .fr-howto-row .fr-menu-item >> nth=-1')
    await page.waitForTimeout(250)
  }
  await audit(page, size, 'frontier-hud', '.fr-hud')
  await step(page, size, 'frontier-score', async () => {
    await page.keyboard.down('Tab')
    await page.waitForTimeout(300)
    await audit(page, size, 'frontier-score', '.fr-score')
    await page.keyboard.up('Tab')
  })
  await step(page, size, 'frontier-pause', async () => {
    await tap(page, '.fr-menu-btn')
    await audit(page, size, 'frontier-pause', '.fr-menu')
    await tap(page, '.fr-menu .fr-menu-quiet >> nth=-1')
  })
  for (const [screen, call] of [
    ['frontier-busy', (m: typeof Fx) => m.frontierBusy()],
    ['frontier-death', (m: typeof Fx) => m.frontierDeath()],
    ['frontier-riders', (m: typeof Fx) => m.frontierRiders()],
  ] as const) {
    if (want(screen)) {
      const scope = await fixture(page, call)
      await page.waitForTimeout(500)
      await audit(page, size, screen, scope, { last: true })
    }
  }
  await ctx.close()
}

async function newContext(
  browser: Browser,
  size: Size,
  state: State | null,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr,
    isMobile: size.touch,
    hasTouch: size.touch,
    reducedMotion: 'reduce',
    ...(state ? { storageState: state } : {}),
  })
  // the dev server's toolbar sits over the bottom of every screen
  await ctx.addInitScript(() => {
    const s = document.createElement('style')
    s.textContent = 'astro-dev-toolbar { display: none !important; }'
    document.addEventListener('DOMContentLoaded', () => document.head.append(s))
  })
  return ctx
}

const { chromium } = await import('playwright')
const chrome = await chromium.launch({ channel: 'chrome' })
// one account for the run: each size's context hands its cookies (the refresh token) to the next
let carried: State | null = null
for (const size of sizes) {
  await guest(chrome, size)
  if (!guestOnly) {
    carried = await member(chrome, size, carried)
  }
  await frontier(chrome, size)
}
await chrome.close()

const total = rows.reduce((n, r) => n + r.findings.length, 0)
if (json) {
  writeFileSync(1, `${JSON.stringify(rows, null, 2)}\n`)
} else {
  for (const r of rows) {
    for (const f of r.findings) {
      console.log(
        `${r.size.padEnd(9)} ${r.screen.padEnd(24)} ${f.kind.padEnd(8)} ${f.el}  “${f.text}”  ${f.detail}`,
      )
    }
  }
  const byKind = new Map<string, number>()
  for (const r of rows) {
    for (const f of r.findings) {
      byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
    }
  }
  console.log(
    `\n${rows.length} screen×size checks, ${total} findings${total ? ` (${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`,
  )
}
process.exitCode = total > 0 ? 1 : 0
