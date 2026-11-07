/**
 * Frontier perf on the floor-device proxy (tools/PERF.md): the loopback town with 31 bots, a phone
 * viewport (812×375 CSS, DPR 3, touch), the floor tier and 4× CPU throttle, in real Chrome.
 *
 *   bun run dev --port 4369          # in another shell
 *   bun tools/frontier-perf.ts [baseUrl] [--cluster] [--rate=4] [--secs=30] [--portrait]
 *     [--view=third|first|top] [--profile] [--seed=7|random] [--spawn=bank-front|x,z|random]
 *     [--prod[=port]] [--no-build] [--alloc]
 *
 * `--profile` prints the main thread's top functions (self and inclusive ms per frame); `--alloc`
 * the garbage made per frame by allocating function (the sampling heap profiler).
 *
 * `--prod` measures the production build, which is the number that matters (dev carries HMR,
 * unminified modules and the float audit's CPU geometry copies). It builds the site into
 * `$TMPDIR/frontier-perf-dist` (outside the tree, so a running dev server doesn't reload) with
 * `PUBLIC_OW_PERF_HARNESS=1` and hidden source maps (which keeps the dev-only `?seed=` /
 * `?spawn=` params and the `__frontier*` / `__owRenderer` hooks; the real deploy never sets it, so
 * they fold away there) and serves it statically on the port (default 4387). `--no-build` reuses
 * the last perf build.
 *
 * Runs are repeatable by default: the loopback lobby's seed is 7 and you start on the bank's
 * front steps (dev-only `?seed=` / `?spawn=` page params), so numbers compare run to run.
 *
 * `--cluster` makes every bot crowd around (and spare) the player, so 20+ riders are on screen at
 * once. Prints CPU p50/p95 (rAF start to end of submit), frame p95, JS heap, draws, triangles and
 * how many riders were in view, sampled every 2 s after a 20 s warm-up. `--view` picks the camera
 * (over the shoulder by default, as players get it; `top` is the old map view), and the camera
 * turns slowly through a full circle while sampling so the horizon is measured in every direction.
 */

import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright'
import { textureMeterScript } from './character-quality/memory.ts'
import { allocProfile, profileMain, serveProd } from './perf-lib.ts'

const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const prodArg = process.argv.find((a) => a === '--prod' || a.startsWith('--prod='))
const prodPort = Number(prodArg?.split('=')[1] ?? '4387')
let stopServer: (() => void) | null = null
if (prodArg) {
  stopServer = serveProd(prodPort, !process.argv.includes('--no-build'))
}
const base =
  process.argv.find((a) => a.startsWith('http')) ??
  (prodArg ? `http://localhost:${prodPort}` : 'http://localhost:4369')
const rate = Number(opt('rate', '4'))
const secs = Number(opt('secs', '30'))
const cluster = process.argv.includes('--cluster')
const portrait = process.argv.includes('--portrait')
const viewMode = opt('view', 'third')
/**
 * Repeatable runs: the loopback lobby's seed (bots, their spawns, the strongbox) and where you
 * first appear, by name or as `x,z` in layout metres. Defaults to seed 7 at the bank's front
 * steps, looking up main street, so two runs (or two commits) see the same scene.
 * `--spawn=random --seed=random` restores the old behaviour.
 */
const SPOTS: Record<string, [number, number]> = {
  'bank-front': [72, 69],
  crossroads: [72, 64],
  'saloon-porch': [56, 58],
  'west-end': [10, 64],
  'east-end': [134, 64],
  depot: [28, 122],
  corral: [14, 34],
}
const spawnArg = opt('spawn', 'bank-front')
const seedArg = opt('seed', '7')
const spawnAt = SPOTS[spawnArg] ?? (spawnArg.includes(',') ? spawnArg.split(',').map(Number) : null)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Snap {
  cpuP50: number
  cpuP95: number
  frameP95: number
  heapMb: number | null
  draws: number
  tris: number
}
interface Extra {
  textures: number
  geometries: number
  textureMb: number
  corpseLod: {
    models: number
    pending: number
    ready: number
    fallback: number
    full: number
    middle: number
    far: number
  }
  ragdolls: Record<string, unknown>
  living: Record<string, number>
  bootFits: { prepared: number; late: number; milliseconds: number }
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
await page.addInitScript({ content: textureMeterScript })
if (!prodArg) {
  await page.routeWebSocket(
    (url) => url.host === new URL(base).host,
    (socket) => socket.send(JSON.stringify({ type: 'connected' })),
  )
}
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: portrait ? 375 : 812,
  height: portrait ? 812 : 375,
  deviceScaleFactor: 3,
  mobile: true,
})
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const q = [
  '?bots=31',
  cluster ? '&cluster' : '',
  `&view=${viewMode}`,
  seedArg === 'random' ? '' : `&seed=${Number(seedArg)}`,
  spawnAt ? `&spawn=${spawnAt.join(',')}` : '',
].join('')
console.log(`seed ${seedArg}, spawn ${spawnAt ? `${spawnArg} (${spawnAt.join(', ')})` : 'random'}`)
await page.goto(`${base}/experiments/out-west/frontier/${q}#perf&tier=floor`)
await page.waitForFunction(() => typeof Reflect.get(globalThis, '__owPerf') === 'function', null, {
  timeout: 60_000,
})
// Prepared VAT variants and actual corpse rigs are part of loading. A fixed eight-second
// delay used to sample unfinished towns on slower machines or after cold asset caches.
await page.waitForFunction(
  () => {
    const f = Reflect.get(globalThis, '__frontier')?.()
    return (
      f?.ready &&
      f.riders === 32 &&
      f.vat?.loading === 0 &&
      f.vat?.queued === 0 &&
      f.corpsePreparation?.loading === 0 &&
      f.corpsePreparation?.queued === 0 &&
      f.corpseLod?.pending === 0 &&
      f.corpseLod.ready === f.corpseLod.models &&
      f.corpseLod.fallback === 0 &&
      f.living?.pending === 0 &&
      f.living.actors === f.riders &&
      f.bootFits?.late === 0
    )
  },
  null,
  { timeout: 180_000 },
)
await page.evaluate(
  () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
)
// The card first opens in a running game frame, after start() resolves.
await page.evaluate(() => {
  const v = Reflect.get(globalThis, '__frontierView') as { closeHowTo?: () => void } | undefined
  v?.closeHowTo?.()
})
await page.waitForFunction(() => !Reflect.get(globalThis, '__frontier')?.().howto)
const ready = await page.evaluate(() => Reflect.get(globalThis, '__frontier')())
await page.evaluate(() => {
  const game = Reflect.get(globalThis, '__frontierGame')
  const builds: { id: number; at: number; ms: number }[] = []
  const measurement = { builds, start: performance.now(), sampleAt: 0 }
  Reflect.set(globalThis, '__livingBuildMeasure', measurement)
  const build = game.crowd.build.bind(game.crowd)
  game.crowd.build = (...args: unknown[]) => {
    const at = performance.now()
    try {
      return build(...args)
    } finally {
      builds.push({
        id: Number(Reflect.get(args[0] as object, 'id')),
        at,
        ms: performance.now() - at,
      })
    }
  }
})
await cdp.send('Emulation.setCPUThrottlingRate', { rate })
await sleep(cluster ? 25_000 : 12_000)
await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)
await page.evaluate(() => {
  Reflect.get(globalThis, '__livingBuildMeasure').sampleAt = performance.now()
})

const rows: (Snap & Extra & { inView: number; near: number; far: number; builds: number })[] = []
for (let t = 0; t < secs; t += 2) {
  if (viewMode !== 'top') {
    // a slow pan: about 30° per sample, so a 30 s run looks all the way round
    await page.evaluate(() => {
      const v = Reflect.get(globalThis, '__frontierView') as
        | { look?: (dx: number, dy: number) => void }
        | undefined
      v?.look?.(240, 0)
    })
  }
  await sleep(2000)
  const s = await page.evaluate(() => {
    const perfFn = Reflect.get(globalThis, '__owPerf') as (() => Snap) | undefined
    const fFn = Reflect.get(globalThis, '__frontier') as (() => Frontier) | undefined
    if (!(perfFn && fFn)) {
      return null // reloading (a dev-server hot update): skip this sample
    }
    const perf = perfFn()
    const f = fFn() as Frontier & Extra
    // riders actually on screen: project each through the live camera (dev builds expose the
    // renderer as __owRenderer); fall back to the guaranteed 18 m view radius (§3.1)
    const r = Reflect.get(globalThis, '__owRenderer') as Record<string, unknown> | undefined
    const cam = Object.values(r ?? {}).find(
      (v) => (v as { isCamera?: boolean } | null)?.isCamera === true,
    ) as
      | {
          matrixWorldInverse: { elements: number[] }
          projectionMatrix: { elements: number[] }
        }
      | undefined
    const onScreen = (x: number, z: number): boolean => {
      if (!cam) {
        return Math.hypot(x - f.x, z - f.z) <= 18
      }
      const v = cam.matrixWorldInverse.elements
      const p = cam.projectionMatrix.elements
      const y = 1
      const vx = (v[0] ?? 0) * x + (v[4] ?? 0) * y + (v[8] ?? 0) * z + (v[12] ?? 0)
      const vy = (v[1] ?? 0) * x + (v[5] ?? 0) * y + (v[9] ?? 0) * z + (v[13] ?? 0)
      const vz = (v[2] ?? 0) * x + (v[6] ?? 0) * y + (v[10] ?? 0) * z + (v[14] ?? 0)
      const cx = (p[0] ?? 0) * vx + (p[8] ?? 0) * vz
      const cy = (p[5] ?? 0) * vy + (p[9] ?? 0) * vz
      const w = -vz
      return w > 0 && Math.abs(cx / w) <= 1 && Math.abs(cy / w) <= 1
    }
    const inView = f.others.filter((o) => onScreen(o.x, o.z)).length
    return {
      ...perf,
      inView,
      near: f.crowd?.near ?? 0,
      far: f.crowd?.far ?? 0,
      builds: f.crowd?.builds ?? 0,
      textures: f.textures,
      geometries: f.geometries,
      textureMb: Number(Reflect.get(globalThis, '__owTextureBytes')?.() ?? 0) / 1_048_576,
      corpseLod: f.corpseLod,
      ragdolls: f.ragdolls,
      living: f.living,
      bootFits: f.bootFits,
    }
  })
  if (s) {
    rows.push(s)
  }
}
if (process.argv.includes('--profile')) {
  await profileMain(cdp, 8000, prodArg !== undefined)
}
if (process.argv.includes('--alloc')) {
  await allocProfile(cdp, 8000, prodArg !== undefined)
}
const livingBuilds = await page.evaluate(() => Reflect.get(globalThis, '__livingBuildMeasure'))
await browser.close()
stopServer?.()

const med = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.floor(a.length / 2)] ?? 0
}
const max = (xs: number[]): number => Math.max(...xs)
const f1 = (n: number): string => n.toFixed(1)
console.log(
  `Frontier ${viewMode} view, ${cluster ? 'clustered' : 'spread'}, ${portrait ? 'portrait' : 'landscape'}, ${rate}× CPU, floor tier, ${rows.length} samples`,
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
console.log(
  `  textures ≤${max(rows.map((r) => r.textures))}, geometries ≤${max(rows.map((r) => r.geometries))}`,
)
console.log(`  texture storage ≤${f1(max(rows.map((r) => r.textureMb)))} MB`)
console.log(`  riders on screen per sample: ${rows.map((r) => r.inView).join(' ')}`)
const output = opt('out', '')
if (output) {
  await writeFile(
    output,
    JSON.stringify(
      {
        base,
        production: Boolean(prodArg),
        rate,
        secs,
        cluster,
        portrait,
        viewMode,
        seedArg,
        spawnAt,
        ready,
        livingBuilds,
        rows,
      },
      null,
      2,
    ),
  )
}
