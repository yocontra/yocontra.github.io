// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: samples are taken one after another on purpose
/**
 * Frontier perf on the floor-device proxy (tools/PERF.md): the loopback town with 31 bots, a phone
 * viewport (812×375 CSS, DPR 3, touch), the floor tier and 4× CPU throttle, in real Chrome.
 *
 *   bun run dev --port 4369          # in another shell
 *   bun tools/frontier-perf.ts [baseUrl] [--cluster] [--rate=4] [--secs=30] [--portrait]
 *
 * `--cluster` makes every bot crowd around (and spare) the player, so 20+ riders are on screen at
 * once. Prints CPU p50/p95 (rAF start to end of submit), frame p95, JS heap, draws, triangles and
 * how many riders were in view, sampled every 2 s after a 20 s warm-up.
 */
import process from 'node:process'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import { chromium } from 'playwright'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4369'
const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const rate = Number(opt('rate', '4'))
const secs = Number(opt('secs', '30'))
const cluster = process.argv.includes('--cluster')
const portrait = process.argv.includes('--portrait')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Snap {
  cpuP50: number
  cpuP95: number
  frameP95: number
  heapMb: number | null
  draws: number
  tris: number
}
interface Frontier {
  x: number
  z: number
  crowd?: { near: number; far: number; builds: number }
  alive: boolean
  others: { x: number; z: number; alive: boolean }[]
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
})
const ctx = await browser.newContext()
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: portrait ? 375 : 812,
  height: portrait ? 812 : 375,
  deviceScaleFactor: 3,
  mobile: true,
})
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const q = `?bots=31${cluster ? '&cluster' : ''}`
await page.goto(`${base}/experiments/out-west/frontier/${q}#perf&tier=floor`)
await page.waitForFunction(() => typeof Reflect.get(globalThis, '__owPerf') === 'function', null, {
  timeout: 60_000,
})
await sleep(8000)
await cdp.send('Emulation.setCPUThrottlingRate', { rate })
await sleep(12_000)
await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)

const rows: (Snap & { inView: number; near: number; far: number; builds: number })[] = []
for (let t = 0; t < secs; t += 2) {
  await sleep(2000)
  const s = await page.evaluate(() => {
    const perfFn = Reflect.get(globalThis, '__owPerf') as (() => Snap) | undefined
    const fFn = Reflect.get(globalThis, '__frontier') as (() => Frontier) | undefined
    if (!(perfFn && fFn)) {
      return null // reloading (a dev-server hot update): skip this sample
    }
    const perf = perfFn()
    const f = fFn()
    // riders within the guaranteed 18 m view radius (§3.1)
    const inView = f.others.filter((o) => Math.hypot(o.x - f.x, o.z - f.z) <= 18).length
    return {
      ...perf,
      inView,
      near: f.crowd?.near ?? 0,
      far: f.crowd?.far ?? 0,
      builds: f.crowd?.builds ?? 0,
    }
  })
  if (s) {
    rows.push(s)
  }
}
await browser.close()

const med = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.floor(a.length / 2)] ?? 0
}
const max = (xs: number[]): number => Math.max(...xs)
const f1 = (n: number): string => n.toFixed(1)
console.log(
  `Frontier ${cluster ? 'clustered' : 'spread'}, ${portrait ? 'portrait' : 'landscape'}, ${rate}× CPU, floor tier, ${rows.length} samples`,
)
console.log(
  `  CPU p50 ${f1(med(rows.map((r) => r.cpuP50)))} ms, p95 ${f1(med(rows.map((r) => r.cpuP95)))} ms (worst window ${f1(max(rows.map((r) => r.cpuP95)))})`,
)
console.log(`  frame p95 ${f1(med(rows.map((r) => r.frameP95)))} ms`)
console.log(
  `  heap ${f1(med(rows.map((r) => r.heapMb ?? 0)))} MB (max ${f1(max(rows.map((r) => r.heapMb ?? 0)))})`,
)
const first = rows[0]?.builds ?? 0
console.log(
  `  crowd: ${med(rows.map((r) => r.near))} skinned + ${med(rows.map((r) => r.far))} VAT drawn; ${(rows.at(-1)?.builds ?? 0) - first} actor casts while sampling`,
)
console.log(
  `  draws ≤${max(rows.map((r) => r.draws))}, tris ≤${Math.round(max(rows.map((r) => r.tris)) / 1000)}k, riders in view ${med(rows.map((r) => r.inView))} (max ${max(rows.map((r) => r.inView))})`,
)
