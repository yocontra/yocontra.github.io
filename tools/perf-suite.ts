// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: screens and samples run one after another on purpose
/**
 * Every out west screen on the floor-device proxy, in the PRODUCTION build (tools/PERF.md): a phone
 * viewport (812×375 CSS at DPR 3, touch), the floor tier and a CPU throttle (4×, plus 6× with
 * `--stress`), in real Chrome. One table, so regressions show.
 *
 *   bun tools/perf-suite.ts [--rate=4] [--stress] [--secs=20] [--screen=substr] [--portrait]
 *     [--no-build] [--port=4387] [--sustained=600] [--profile=screen]
 *
 * Screens: the title, the saloon hub, the Outfitter, a Quick Draw duel (level 7, played: it holds to
 * walk, waits, fires on the call, then sits through the kill cam; one row per phase), and Frontier
 * (31 bots, seed 7 from the bank steps) in third person, first person and top-down, spread and
 * packed. Bounty Hunt is the duel's scene and director against a remote opponent; it needs the API
 * and a second client, so the Quick Draw rows stand in for it.
 *
 * Each row: draws and triangles (max), textures (count, estimated MB), JS heap (after a forced GC
 * before sampling, then the median), CPU p50 / p95 / p99 per frame (every rAF callback timed by an
 * init script, so it's the whole frame's JavaScript and GL submission), long frames (a frame
 * interval over 16.7 ms by more than a fifth: a missed vsync) and frames whose CPU alone is over
 * 16.7 ms.
 *
 * `--sustained=600` adds a 10-minute packed Frontier run and prints each minute's CPU p95, long
 * frames, the tier, the dynamic-resolution scale and thermal drops (the renderer drops a tier after
 * 3 minutes pinned at its lowest scale). Desktop emulation can't heat a phone: this checks the
 * game's own adaptation and leaks over time, and the real-device checklist in PERF.md still applies.
 */
import process from 'node:process'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import { type BrowserContext, type CDPSession, chromium, type Page } from 'playwright'
import { profileMain, serveProd } from './perf-lib.ts'

const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const port = Number(opt('port', '4387'))
const base = `http://localhost:${port}`
const secs = Number(opt('secs', '20'))
const only = opt('screen', '')
const portrait = process.argv.includes('--portrait')
const rates = [Number(opt('rate', '4')), ...(process.argv.includes('--stress') ? [6] : [])]
const sustained = Number(opt('sustained', '0'))
const profileScreen = opt('profile', '')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const GAME = `${base}/experiments/out-west/`
const FRONTIER = `${base}/experiments/out-west/frontier/?bots=31&seed=7&spawn=72,69`
const HASH = '#perf&tier=floor'

/**
 * Times every rAF callback (all of a frame's callbacks share its timestamp) and tags the frame with
 * the renderer's label (`__owPerfLabel`: the duel phase, `frontier`). `__perfFrames()` drains
 * [timestamp, cpu ms, label] rows.
 */
const SAMPLER = `(() => {
  const raf = window.requestAnimationFrame.bind(window)
  const rows = []
  let cur = -1, acc = 0, label = ''
  const flush = () => { if (cur >= 0) rows.push([cur, acc, label]) }
  window.requestAnimationFrame = (cb) => raf((ts) => {
    if (ts !== cur) { flush(); cur = ts; acc = 0 }
    const t0 = performance.now()
    try { cb(ts) } finally {
      acc += performance.now() - t0
      const lf = globalThis.__owPerfLabel
      label = typeof lf === 'function' ? lf() : ''
    }
  })
  globalThis.__perfFrames = () => rows.splice(0)
})()`

type Frame = [number, number, string]
interface Snap {
  draws: number
  tris: number
  textures: number
  textureMb: number
  heapMb: number | null
  tier: string
  scale: number
  thermalDrops: number
}
interface Row {
  screen: string
  rate: number
  frames: Frame[]
  snaps: Snap[]
}

const rows: Row[] = []

async function phone(ctx: BrowserContext): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: portrait ? 375 : 812,
    height: portrait ? 812 : 375,
    deviceScaleFactor: 3,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.addInitScript(SAMPLER)
  return { page, cdp }
}

const snap = (page: Page): Promise<Snap | null> =>
  page.evaluate(() => {
    const f = Reflect.get(globalThis, '__owPerf') as (() => Snap) | undefined
    return f ? f() : null
  })

const drain = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => (Reflect.get(globalThis, '__perfFrames') as () => Frame[])())

/** Sample `ms` of frames, with a snapshot every 4 s (and `each` called every 2 s). */
async function sample(
  page: Page,
  ms: number,
  each?: (i: number) => Promise<void>,
): Promise<{ frames: Frame[]; snaps: Snap[] }> {
  await drain(page)
  const snaps: Snap[] = []
  for (let t = 0, i = 0; t < ms; t += 2000, i++) {
    await each?.(i)
    await sleep(2000)
    if (i % 2 === 1) {
      const s = await snap(page)
      if (s) {
        snaps.push(s)
      }
    }
  }
  return { frames: await drain(page), snaps }
}

const want = (screen: string): boolean => !only || screen.includes(only)

async function gc(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)
}

/** Title, hub and Outfitter: one page walked through. */
async function menus(ctx: BrowserContext, rate: number): Promise<void> {
  if (!['title', 'hub', 'outfitter'].some(want)) {
    return
  }
  const { page, cdp } = await phone(ctx)
  await page.goto(`${GAME}${HASH}`)
  await page.locator('.ow-title.ready').waitFor({ timeout: 180_000 })
  await sleep(3000)
  const run = async (screen: string, each?: (i: number) => Promise<void>) => {
    await gc(cdp)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate })
    await sleep(3000)
    const r = await sample(page, secs * 1000, each)
    await maybeProfile(screen, cdp)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    rows.push({ screen, rate, ...r })
  }
  if (want('title')) {
    await run('title')
  }
  await page.locator('.ow-start').tap()
  await page.locator('.ow-hub.on').waitFor({ timeout: 120_000 })
  await sleep(3000)
  if (want('hub')) {
    await run('hub')
  }
  if (want('outfitter')) {
    await page.locator('.ow-tile-store').first().tap()
    await page.locator('.ow-store.on').waitFor({ timeout: 30_000 })
    await sleep(2500)
    const tabs = await page.locator('.ow-store-tab').count()
    // browse while sampling: a tab, then an item, every 2 s (the dressing and thumbnails)
    await run('outfitter', async (i) => {
      if (i % 2 === 0 && tabs > 0) {
        await page
          .locator('.ow-store-tab')
          .nth((i / 2) % tabs)
          .tap()
          .catch(() => undefined)
      } else {
        await page
          .locator('.ow-item')
          .nth(i % 6)
          .tap()
          .catch(() => undefined)
      }
    })
  }
  await page.close()
}

const touch = (cdp: CDPSession, type: 'touchStart' | 'touchEnd', x: number, y: number) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  })

const label = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const f = Reflect.get(globalThis, '__owPerfLabel') as (() => string) | undefined
    return f ? f() : ''
  })

interface DuelState {
  holding: boolean
  fired: boolean
  doneAt: number
  x: number
  y: number
}

/** One look at the duel: hold through the walk, fire on the call; true 7 s after it's decided. */
async function drive(page: Page, cdp: CDPSession, st: DuelState): Promise<boolean> {
  const ph = await label(page)
  if (ph === 'walk' && !st.holding) {
    await touch(cdp, 'touchStart', st.x, st.y)
    st.holding = true
  } else if (ph !== 'walk' && st.holding) {
    await touch(cdp, 'touchEnd', st.x, st.y)
    st.holding = false
  }
  if (ph === 'call' && !st.fired) {
    await sleep(180)
    await page.touchscreen.tap(st.x, st.y)
    st.fired = true
  }
  if ((ph === 'win' || ph === 'lose' || ph === 'coward') && !st.doneAt) {
    st.doneAt = Date.now()
  }
  return st.doneAt > 0 && Date.now() - st.doneAt > 7000
}

/** A Quick Draw duel, played through: hold to walk, fire on the call, the kill cam. */
async function duel(ctx: BrowserContext, rate: number): Promise<void> {
  if (!want('duel')) {
    return
  }
  const { page, cdp } = await phone(ctx)
  await page.goto(`${GAME}#level=7&perf&tier=floor`)
  await page.locator('.ow-title.ready').waitFor({ timeout: 180_000 })
  await sleep(2000)
  await page.locator('.ow-start').tap()
  const vp = page.viewportSize() ?? { width: 812, height: 375 }
  const cx = vp.width / 2
  const cy = vp.height / 2
  // through the intro and poster to the walk, unthrottled
  for (let i = 0; i < 120 && (await label(page)) !== 'walk'; i++) {
    if (i % 4 === 0) {
      await page.touchscreen.tap(cx, cy).catch(() => undefined)
    }
    await sleep(500)
  }
  await gc(cdp)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  await drain(page)
  const snaps: Snap[] = []
  const frames: Frame[] = []
  const st: DuelState = { holding: false, fired: false, doneAt: 0, x: cx, y: cy }
  const t0 = Date.now()
  while (Date.now() - t0 < 150_000 && !(await drive(page, cdp, st))) {
    frames.push(...(await drain(page)))
    if (frames.length % 6 === 0) {
      const s = await snap(page)
      if (s) {
        snaps.push(s)
      }
    }
    await sleep(200)
  }
  frames.push(...(await drain(page)))
  await maybeProfile('duel', cdp)
  // one row per phase
  for (const ph of ['walk', 'turn', 'wait', 'call', 'win', 'lose', 'coward']) {
    const f = frames.filter((r) => r[2] === ph)
    if (f.length > 10) {
      rows.push({ screen: `duel ${ph === 'win' ? 'win+killcam' : ph}`, rate, frames: f, snaps })
    }
  }
  await page.close()
}

async function frontier(
  ctx: BrowserContext,
  rate: number,
  { view, packed, ms }: { view: string; packed: boolean; ms: number },
): Promise<Row | null> {
  const screen = `frontier ${view} ${packed ? 'packed' : 'spread'}`
  if (!want(screen) && ms === secs * 1000) {
    return null
  }
  const { page, cdp } = await phone(ctx)
  await page.goto(`${FRONTIER}${packed ? '&cluster' : ''}&view=${view}${HASH}`)
  await page.waitForFunction(
    () => typeof Reflect.get(globalThis, '__owPerf') === 'function',
    null,
    {
      timeout: 180_000,
    },
  )
  await sleep(8000)
  await page.evaluate(() => {
    const v = Reflect.get(globalThis, '__frontierView') as { closeHowTo?: () => void } | undefined
    v?.closeHowTo?.()
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  await sleep(packed ? 20_000 : 10_000)
  await gc(cdp)
  const pan = async () => {
    if (view !== 'top') {
      await page.evaluate(() => {
        const v = Reflect.get(globalThis, '__frontierView') as
          | { look?: (dx: number, dy: number) => void }
          | undefined
        v?.look?.(240, 0)
      })
    }
  }
  const row: Row = { screen, rate, frames: [], snaps: [] }
  if (ms > secs * 1000) {
    // sustained: a line a minute
    for (let m = 0; m * 60_000 < ms; m++) {
      const r = await sample(page, 60_000, pan)
      row.frames.push(...r.frames)
      row.snaps.push(...r.snaps)
      const st = stats(r.frames)
      const last = r.snaps.at(-1)
      console.log(
        `  minute ${m + 1}: CPU p95 ${st.p95.toFixed(1)} ms, long ${st.longPct.toFixed(1)}%, heap ${last?.heapMb?.toFixed(0) ?? '?'} MB, tier ${last?.tier ?? '?'}, scale ${last?.scale.toFixed(2) ?? '?'}, thermal drops ${last?.thermalDrops ?? '?'}`,
      )
    }
  } else {
    const r = await sample(page, ms, pan)
    row.frames = r.frames
    row.snaps = r.snaps
    await maybeProfile(screen, cdp)
  }
  await page.close()
  return row
}

async function maybeProfile(screen: string, cdp: CDPSession): Promise<void> {
  if (profileScreen && screen.includes(profileScreen)) {
    console.log(`profile: ${screen}`)
    await profileMain(cdp, 8000, true)
  }
}

function pct(xs: number[], p: number): number {
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0
}

function stats(frames: Frame[]): {
  n: number
  p50: number
  p95: number
  p99: number
  longPct: number
  cpuOver: number
} {
  const cpu = frames.map((f) => f[1])
  let long = 0
  for (let i = 1; i < frames.length; i++) {
    const dt = (frames[i]?.[0] ?? 0) - (frames[i - 1]?.[0] ?? 0)
    // a gap over 100 ms is the harness pausing, not a frame
    if (dt > 16.7 * 1.2 && dt < 100) {
      long++
    }
  }
  return {
    n: frames.length,
    p50: pct(cpu, 0.5),
    p95: pct(cpu, 0.95),
    p99: pct(cpu, 0.99),
    longPct: (long / Math.max(1, frames.length - 1)) * 100,
    cpuOver: cpu.filter((c) => c > 16.7).length,
  }
}

const server = serveProd(port, !process.argv.includes('--no-build'))
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
})
try {
  for (const rate of rates) {
    const ctx = await browser.newContext({ hasTouch: true })
    await menus(ctx, rate)
    await duel(ctx, rate)
    for (const view of ['third', 'first', 'top']) {
      for (const packed of [false, true]) {
        const r = await frontier(ctx, rate, { view, packed, ms: secs * 1000 })
        if (r) {
          rows.push(r)
        }
      }
    }
    if (sustained > 0 && rate === rates[0]) {
      console.log(`sustained: frontier third packed, ${sustained} s at ${rate}×`)
      const r = await frontier(ctx, rate, { view: 'third', packed: true, ms: sustained * 1000 })
      if (r) {
        rows.push({ ...r, screen: `sustained ${Math.round(sustained / 60)} min` })
      }
    }
    await ctx.close()
  }
} finally {
  await browser.close()
  server()
}

const max = (xs: number[]): number => (xs.length > 0 ? Math.max(...xs) : 0)
const med = (xs: number[]): number => pct(xs, 0.5)
const head = [
  'screen',
  'rate',
  'draws',
  'tris',
  'tex',
  'tex MB',
  'heap MB',
  'CPU p50',
  'p95',
  'p99',
  'long %',
  'CPU>16.7',
  'frames',
]
const table = rows.map((r) => {
  const s = stats(r.frames)
  return [
    r.screen,
    `${r.rate}×`,
    String(max(r.snaps.map((x) => x.draws))),
    `${Math.round(max(r.snaps.map((x) => x.tris)) / 1000)}k`,
    String(max(r.snaps.map((x) => x.textures))),
    max(r.snaps.map((x) => x.textureMb)).toFixed(0),
    med(r.snaps.map((x) => x.heapMb ?? 0)).toFixed(1),
    s.p50.toFixed(1),
    s.p95.toFixed(1),
    s.p99.toFixed(1),
    s.longPct.toFixed(1),
    String(s.cpuOver),
    String(s.n),
  ]
})
const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => (r[i] ?? '').length)))
const line = (cells: string[]): string =>
  `| ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join(' | ')} |`
console.log(line(head))
console.log(
  `|${widths.map((w, i) => (i === 0 ? `:${'-'.repeat(w + 1)}` : `${'-'.repeat(w + 1)}:`)).join('|')}|`,
)
for (const r of table) {
  console.log(line(r))
}
console.log(
  'Bounty Hunt shares the duel rows (same scene and director; it needs the API and a second client).',
)
