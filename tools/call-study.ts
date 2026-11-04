// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
// biome-ignore-all lint/suspicious/noConsole: a CLI study reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: one duel at a time, in order
/**
 * The call, sampled long: the same outlaw's duel replayed `--calls=8` times on the production
 * build (perf harness hooks on) at 4× CPU, phone viewport, floor tier. Every frame from the last
 * of the wait to a second after the shot is kept with its offset from the call, so the call's
 * worst frames show where they fall (first frame of DRAW!, the shot, the kill cam), not just a
 * p95 over a dozen frames.
 *
 *   bun tools/call-study.ts [--level=7] [--calls=8] [--rate=4] [--port=4424] [--no-build] [--fire]
 *
 * `--fire` shoots back ~200 ms after the call (a win, the kill cam); without it he shoots you
 * (a lose, and the retry replays the same call).
 */
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import { type BrowserContext, type CDPSession, chromium, type Page } from 'playwright'
import { serveProd, startProfile, stopProfile } from './perf-lib.ts'

const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const level = Number(opt('level', '7'))
const calls = Number(opt('calls', '8'))
const rate = Number(opt('rate', '4'))
const port = Number(opt('port', '4424'))
const fire = process.argv.includes('--fire')
/** `--trace`: a Chrome trace of each wait and call; main-thread time by event, wait vs call. */
const trace = process.argv.includes('--trace')
/** `--burst`: profile the first wait and call, and itemise every frame over 6 ms (its JS). */
const burst = process.argv.includes('--burst')
let profiling: 'off' | 'on' | 'done' = 'off'
interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur?: number
  tid: number
  args?: { data?: { message?: string } }
}
const traced: {
  wait: Map<string, number>
  call: Map<string, number>
  waitMs: number
  callMs: number
} = {
  wait: new Map(),
  call: new Map(),
  waitMs: 0,
  callMs: 0,
}

/** Sum each event's duration (complete events on one thread) inside [t0, t1). */
function tally(
  events: TraceEvent[],
  w: { tid: number; t0: number; t1: number },
  into: Map<string, number>,
): void {
  const { tid, t0, t1 } = w
  for (const e of events) {
    if (e.tid === tid && e.ph === 'X' && e.dur !== undefined && e.ts >= t0 && e.ts < t1) {
      into.set(e.name, (into.get(e.name) ?? 0) + e.dur / 1000)
    }
  }
}

async function collect(): Promise<TraceEvent[]> {
  const events: TraceEvent[] = []
  // the Tracing domain's events aren't in Playwright's CDPSession typings
  const bus = cdp as unknown as {
    on: (e: string, f: (d: { value: TraceEvent[] }) => void) => void
    once: (e: string, f: () => void) => void
  }
  bus.on('Tracing.dataCollected', (d) => events.push(...d.value))
  const done = new Promise<void>((r) => bus.once('Tracing.tracingComplete', () => r()))
  await cdp.send('Tracing.end')
  await done
  return events
}
const stop = serveProd(port, !process.argv.includes('--no-build'))

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
      const was = label
      label = typeof lf === 'function' ? lf() : ''
      if (label !== was) { console.timeStamp('ow:' + label) }
    }
  })
  globalThis.__perfFrames = () => rows.splice(0)
})()`

type Frame = [number, number, string]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
const ctx: BrowserContext = await browser.newContext({ hasTouch: true })
const page: Page = await ctx.newPage()
const cdp: CDPSession = await ctx.newCDPSession(page)
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 812,
  height: 375,
  deviceScaleFactor: 3,
  mobile: true,
})
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await page.addInitScript(SAMPLER)
await page.goto(`http://localhost:${port}/experiments/out-west/#level=${level}&perf&tier=floor`)
await page.locator('.ow-title.ready').waitFor({ timeout: 180_000 })
await sleep(2000)
await page.locator('.ow-start').tap()
const label = (): Promise<string> =>
  page.evaluate(
    () => (Reflect.get(globalThis, '__owPerfLabel') as (() => string) | undefined)?.() ?? '',
  )
const drain = (): Promise<Frame[]> =>
  page.evaluate(() => (Reflect.get(globalThis, '__perfFrames') as () => Frame[])())
const touch = (type: 'touchStart' | 'touchEnd') =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: 406, y: 187, id: 1 }],
  })

/** Offset (frames) from the call's first frame → every CPU ms seen there. */
const byOffset = new Map<number, number[]>()
const worst: { cpu: number; at: number; label: string; run: number }[] = []
for (let run = 0; run < calls; run++) {
  // through the poster or the retry card to the walk
  for (let i = 0; i < 200 && (await label()) !== 'walk'; i++) {
    if (i % 4 === 0) {
      await page.touchscreen.tap(406, 187).catch(() => undefined)
    }
    await sleep(300)
  }
  if (run === 0) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  }
  await drain()
  if (trace) {
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8,blink,gpu',
      transferMode: 'ReportEvents',
    })
  }
  let holding = false
  let fired = false
  let doneAt = 0
  const frames: Frame[] = []
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ph = await label()
    if (ph === 'walk' && !holding) {
      await touch('touchStart')
      holding = true
    } else if (ph !== 'walk' && holding) {
      await touch('touchEnd')
      holding = false
    }
    if (burst && profiling === 'off' && ph === 'wait') {
      await startProfile(cdp)
      profiling = 'on'
    }
    if (burst && profiling === 'on' && doneAt && Date.now() - doneAt > 300) {
      await stopProfile(cdp, true, 6)
      profiling = 'done'
    }
    if (fire && ph === 'call' && !fired) {
      await sleep(150)
      await page.touchscreen.tap(406, 187)
      fired = true
    }
    if ((ph === 'win' || ph === 'lose' || ph === 'coward') && !doneAt) {
      doneAt = Date.now()
    }
    frames.push(...(await drain()))
    if (doneAt && Date.now() - doneAt > 1500) {
      break
    }
    await sleep(40)
  }
  frames.push(...(await drain()))
  if (trace) {
    const events = await collect()
    const stamp = (m: string) =>
      events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === m)
    const c = stamp('ow:call')
    const after = events
      .filter(
        (e) => e.name === 'TimeStamp' && c && e.ts > c.ts && e.args?.data?.message !== 'ow:call',
      )
      .sort((a, b) => a.ts - b.ts)[0]
    if (c && run === 0) {
      // the first call of the session: everything over 0.3 ms in its first frames
      console.log('first call, main-thread events in its first 40 ms:')
      for (const e of events
        .filter(
          (x) =>
            x.tid === c.tid &&
            x.ph === 'X' &&
            (x.dur ?? 0) > 300 &&
            x.ts >= c.ts - 20_000 &&
            x.ts < c.ts + 40_000,
        )
        .sort((x, y) => x.ts - y.ts)) {
        console.log(
          `  +${((e.ts - c.ts) / 1000).toFixed(1).padStart(6)} ms  ${((e.dur ?? 0) / 1000).toFixed(2).padStart(6)} ms  ${e.name}`,
        )
      }
    }
    if (c && after) {
      const span = after.ts - c.ts
      tally(events, { tid: c.tid, t0: c.ts - span, t1: c.ts }, traced.wait)
      tally(events, { tid: c.tid, t0: c.ts, t1: after.ts }, traced.call)
      traced.waitMs += span / 1000
      traced.callMs += span / 1000
    }
  }
  const callAt = frames.findIndex((f) => f[2] === 'call')
  if (callAt < 0) {
    console.log(`run ${run}: no call seen`)
    continue
  }
  const span = frames.slice(Math.max(0, callAt - 10), callAt + 90)
  span.forEach((f, i) => {
    const at = i - Math.min(10, callAt)
    const list = byOffset.get(at) ?? []
    list.push(f[1])
    byOffset.set(at, list)
    worst.push({ cpu: f[1], at, label: f[2], run })
  })
  const callFrames = frames.filter((f) => f[2] === 'call').map((f) => f[1])
  console.log(
    `run ${run}: ${callFrames.length} call frames, max ${Math.max(...callFrames).toFixed(1)} ms, first ${callFrames
      .slice(0, 4)
      .map((c) => c.toFixed(1))
      .join(' ')}`,
  )
}
const all = worst.filter((w) => w.label === 'call').map((w) => w.cpu)
all.sort((a, b) => a - b)
const pct = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))] ?? 0
console.log(
  `\ncall frames: ${all.length}, p50 ${pct(0.5).toFixed(1)} p95 ${pct(0.95).toFixed(1)} max ${pct(1).toFixed(1)} ms`,
)
console.log('worst frames (offset from the call, phase):')
for (const w of worst.sort((a, b) => b.cpu - a.cpu).slice(0, 15)) {
  console.log(
    `  ${w.cpu.toFixed(1).padStart(5)} ms  @${String(w.at).padStart(3)}  ${w.label}  run ${w.run}`,
  )
}
console.log('mean CPU by offset:')
for (const at of [...byOffset.keys()].sort((a, b) => a - b).filter((a) => a >= -2 && a <= 12)) {
  const l = byOffset.get(at) ?? []
  console.log(
    `  @${String(at).padStart(3)}  ${(l.reduce((s, v) => s + v, 0) / l.length).toFixed(1)} ms (n ${l.length})`,
  )
}
if (trace) {
  console.log(
    `\nmain thread, ms per second of phase (wait ${traced.waitMs.toFixed(0)} ms, call ${traced.callMs.toFixed(0)} ms sampled):`,
  )
  const names = new Set([...traced.wait.keys(), ...traced.call.keys()])
  const rows = [...names].map((n) => ({
    n,
    w: ((traced.wait.get(n) ?? 0) / traced.waitMs) * 1000,
    c: ((traced.call.get(n) ?? 0) / traced.callMs) * 1000,
  }))
  for (const r of rows.sort((a, b) => b.c - b.w - (a.c - a.w)).slice(0, 25)) {
    console.log(
      `  ${r.n.padEnd(36)} wait ${r.w.toFixed(1).padStart(7)}  call ${r.c.toFixed(1).padStart(7)}  Δ ${(r.c - r.w).toFixed(1)}`,
    )
  }
}
await browser.close()
stop()
