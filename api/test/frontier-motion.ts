/**
 * Frontier motion smoothness: walk a rider in straight lines at constant input and measure how
 * evenly your own rendered position and the camera advance, frame by frame (stutter shows up as
 * per-frame speed jitter: a smooth walk moves `RUN_SPEED × dt` every frame).
 *
 * The real client in Chrome, against the local Worker's Lobby DO (`--mode remote`, the default) or
 * the in-browser loopback town (`--mode loopback`). Network conditions are shaped in the page:
 * every WebSocket frame, both ways, is held for `lag + random(0..jitter)` ms (one way), in order,
 * like TCP. The display rate is pinned with a `requestAnimationFrame` shim (`--hz 60|120|144`).
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8814 --inspector-port 9254 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8814 bun --bun astro dev --port 4374
 *   bun api/test/frontier-motion.ts [--site http://localhost:4374] [--mode remote|loopback]
 *     [--rtt 120] [--jitter 30] [--hz 60] [--secs 12] [--throttle 1] [--shots dir]
 *
 * Prints the per-frame speed mean / std dev / worst spike for the rendered rider and the camera,
 * reconciliation corrections (smoothed, snapped, mean and worst size), and frame CPU p95. Not part
 * of `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: the walk is scripted one leg after another
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { type Browser, chromium, type Page } from 'playwright'
import { RUN_SPEED } from '../../src/experiments/out-west/ffa/sim/constants.ts'
import { openLocalD1, seedPlayer } from './local-d1.ts'

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4374')
const MODE = arg('--mode', 'remote')
const RTT = Number(arg('--rtt', '0'))
const JITTER = Number(arg('--jitter', '0'))
const HZ = Number(arg('--hz', '60'))
const SECS = Number(arg('--secs', '12'))
const THROTTLE = Number(arg('--throttle', '1'))
const SHOTS = arg('--shots', '')
const JSON_OUT = process.argv.includes('--json')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Pilot {
  go: (x: number, z: number) => boolean
  walking: () => boolean
  stick: (mx: number, mz: number) => void
  release: () => void
}
interface Trace {
  start: () => void
  stop: () => number[][]
  corr: () => { smooth: number; snap: number; sumM: number; maxM: number }
}

const browser: Browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
  ],
})
const WATCH = process.argv.includes('--watch')

async function openRider(name: string, spotX: number, spotZ: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`${name} page error:`, e.message))

  // A fixed-rate display: rAF callbacks on an exact 1000/hz grid, stamped with the grid time (as a
  // real vsync'd rAF is), whatever the headless compositor's own cadence.
  await page.addInitScript((hz: number) => {
    const period = 1000 / hz
    type Cb = (t: number) => void
    const g = globalThis as unknown as {
      requestAnimationFrame: (cb: Cb) => number
      cancelAnimationFrame: (id: number) => void
    }
    let queue: Cb[] = []
    let next = performance.now() + period
    let id = 0
    const pump = (): void => {
      const now = performance.now()
      if (now >= next) {
        const stamp = next
        while (next <= now) {
          next += period
        }
        const run = queue
        queue = []
        for (const cb of run) {
          cb(stamp)
        }
      }
      setTimeout(pump, Math.max(0, next - performance.now() - 0.5))
    }
    setTimeout(pump, period)
    g.requestAnimationFrame = (cb: Cb): number => {
      queue.push(cb)
      return ++id
    }
    g.cancelAnimationFrame = (): void => {
      queue = []
    }
  }, HZ)

  // Shape the lobby WebSocket: one-way lag plus uniform jitter, in order, both directions.
  if (MODE === 'remote' && (oneWay > 0 || JITTER > 0)) {
    await page.routeWebSocket(/\/town\/.*\/ws/u, (ws) => {
      const server = ws.connectToServer()
      let lastUp = 0
      let lastDown = 0
      const due = (prev: number): number =>
        Math.max(prev, performance.now() + oneWay + Math.random() * JITTER)
      const at = (t: number, fn: () => void): void => {
        setTimeout(fn, Math.max(0, t - performance.now()))
      }
      ws.onMessage((m) => {
        lastUp = due(lastUp)
        at(lastUp, () => server.send(m))
      })
      server.onMessage((m) => {
        lastDown = due(lastDown)
        at(lastDown, () => ws.send(m))
      })
    })
  }

  let q: URLSearchParams
  if (db) {
    const player = await seedPlayer(db, { name, purse: 500, clears: 7 })
    q = new URLSearchParams({
      server: 'remote',
      bots: arg('--bots', '0'),
      debug: '1',
      token: player.token,
    })
  } else {
    q = new URLSearchParams({
      server: 'loopback',
      bots: arg('--bots', '0'),
      debug: '1',
      lag: String(oneWay),
      jitter: String(JITTER),
    })
  }
  await page.goto(`${SITE}/experiments/out-west/frontier/?${q.toString()}#tier=floor`)
  await page.waitForFunction(
    () => {
      const f = Reflect.get(globalThis, '__frontier') as (() => { alive: boolean }) | undefined
      return f?.().alive === true
    },
    null,
    { timeout: 90_000 },
  )
  if (THROTTLE > 1) {
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  }
  const where = (): Promise<{ x: number; z: number }> =>
    page.evaluate(() => {
      const d = (Reflect.get(globalThis, '__frontier') as () => Record<string, unknown>)()
      return { x: Number(d.x), z: Number(d.z) }
    })
  for (let attempt = 0; attempt < 4; attempt++) {
    const routed = await page.evaluate(
      ([x, z]) => (Reflect.get(globalThis, '__frontierPilot') as Pilot).go(x ?? 0, z ?? 0),
      [spotX, spotZ],
    )
    for (let i = 0; i < 150; i++) {
      await sleep(500)
      const walking = await page.evaluate(() =>
        (Reflect.get(globalThis, '__frontierPilot') as Pilot).walking(),
      )
      if (!walking) {
        break
      }
    }
    const p = await where()
    if (Math.hypot(p.x - spotX, p.z - spotZ) < 2) {
      break
    }
    console.error(`${name}: not there yet (routed ${routed}, at ${p.x}, ${p.z}); retrying`)
  }
  return page
}

const oneWay = RTT / 2
const db = MODE === 'remote' ? openLocalD1() : null
// Main street runs east-west through the middle of town: walk there, then pace it. The watcher
// (`--watch`, a second rider) stands a few metres off and records the walker as a remote rider.
const [page, watcher] = await Promise.all([
  openRider('Motion Rider', 60, 61),
  WATCH ? openRider('Motion Watcher', 56, 67) : Promise.resolve(null),
])
await sleep(500)

// The walk, scheduled inside the page so the stick changes land on time: a square (east, south,
// west, north; `--leg` ms per side, default 800), or `--line` (east and back, 2400 ms legs). With
// `--sweep` the aim turns steadily (one turn per 4 s) the way a mouse does, so input goes out at
// the full 10 Hz.
const LINE = process.argv.includes('--line')
const SWEEP = process.argv.includes('--sweep')
const legMs = Number(arg('--leg', LINE ? '2400' : '800'))
await page.evaluate(() => (Reflect.get(globalThis, '__frontierTrace') as Trace).start())
await watcher?.evaluate(() => (Reflect.get(globalThis, '__frontierTrace') as Trace).start())
const c0 = await page.evaluate(() => (Reflect.get(globalThis, '__frontierTrace') as Trace).corr())
const legs = Math.max(2, Math.round((SECS * 1000) / legMs))
await page.evaluate(
  ({ legs: n, legMs: ms, line, sweep, stall }) => {
    const pilot = Reflect.get(globalThis, '__frontierPilot') as Pilot & {
      aimPoint: (x: number, z: number) => void
    }
    const dirs = line
      ? [
          [1, 0],
          [-1, 0],
        ]
      : [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ]
    const starts: number[] = []
    Reflect.set(globalThis, '__motionLegs', starts)
    let i = 0
    const leg = (): void => {
      if (i >= n) {
        pilot.release()
        return
      }
      const d = dirs[i % dirs.length] ?? [1, 0]
      pilot.stick(d[0] ?? 0, d[1] ?? 0)
      starts.push(performance.now())
      i++
      setTimeout(leg, ms)
    }
    leg()
    if (stall > 0) {
      // A long frame (a GC, a shader compile, a tab switch) every 5 s.
      const sid = setInterval(() => {
        if (i >= n) {
          clearInterval(sid)
          return
        }
        const until = performance.now() + stall
        while (performance.now() < until) {
          // busy
        }
      }, 5000)
    }
    if (sweep) {
      const t0 = performance.now()
      const id = setInterval(() => {
        if (i >= n) {
          clearInterval(id)
          return
        }
        const f = (Reflect.get(globalThis, '__frontier') as () => Record<string, unknown>)()
        const a = ((performance.now() - t0) / 4000) * Math.PI * 2
        pilot.aimPoint(Number(f.x) + Math.cos(a) * 8, Number(f.z) + Math.sin(a) * 8)
      }, 30)
    }
  },
  { legs, legMs, line: LINE, sweep: SWEEP, stall: Number(arg('--stall', '0')) },
)
if (SHOTS) {
  await sleep(legMs * 1.5)
  for (let k = 0; k < 6; k++) {
    await page.screenshot({ path: `${SHOTS}-${k}.png` })
    await sleep(60)
  }
}
await sleep(legs * legMs + 300)
const legStarts = await page.evaluate(() => Reflect.get(globalThis, '__motionLegs') as number[])
const rows = await page.evaluate(() => (Reflect.get(globalThis, '__frontierTrace') as Trace).stop())
const watched =
  (await watcher?.evaluate(() => (Reflect.get(globalThis, '__frontierTrace') as Trace).stop())) ??
  []
const c1 = await page.evaluate(() => (Reflect.get(globalThis, '__frontierTrace') as Trace).corr())
await browser.close()
const DUMP = arg('--dump', '')
if (DUMP) {
  writeFileSync(DUMP, JSON.stringify({ legStarts, rows }))
}

// --- analysis ---------------------------------------------------------------------------------

const F = { t: 0, dt: 1, ownX: 2, ownZ: 3, camX: 4, camZ: 5, cpu: 14 }
/**
 * Frames to judge: skip the corner itself (the turn lands on the next 50 ms tick and the frame
 * across it is legitimately shorter), not the time after it, when a late correction would land.
 */
const settled = (t: number): boolean => {
  let start = -1
  for (const s of legStarts) {
    if (s <= t) {
      start = s
    }
  }
  return start >= 0 && t - start > 130 && t - (legStarts.at(-1) ?? 0) < legMs - 50
}

interface Stat {
  mean: number
  sd: number
  spike: number
  /** Frames whose speed is more than 25% off the walk speed. */
  badPct: number
  /** Worst per-frame position error against a constant-speed walk (cm). */
  n: number
}

function stats(
  xi: number,
  zi: number,
  from: number[][] = rows,
  keep: (t: number) => boolean = settled,
): Stat {
  const v: { t: number; v: number }[] = []
  for (let i = 1; i < from.length; i++) {
    const a = from[i - 1]
    const b = from[i]
    if (!(a && b && keep(b[F.t] ?? 0) && keep(a[F.t] ?? 0))) {
      continue
    }
    const dt = ((b[F.t] ?? 0) - (a[F.t] ?? 0)) / 1000
    if (dt <= 0) {
      continue
    }
    const dx = (b[xi] ?? 0) - (a[xi] ?? 0)
    const dz = (b[zi] ?? 0) - (a[zi] ?? 0)
    if (!(Number.isFinite(dx) && Number.isFinite(dz)) || Math.hypot(dx, dz) > 3) {
      // no remote in view, or a different one (or a respawn)
      continue
    }
    v.push({ t: b[F.t] ?? 0, v: Math.hypot(dx, dz) / dt })
  }
  // Stutter is the frame-to-frame part: each frame's speed against its own ±100 ms average (the
  // camera's look-ahead easing after a turn is slow, not stutter, and averages out).
  const dev: number[] = []
  for (const s of v) {
    let sum = 0
    let k = 0
    for (const o of v) {
      if (Math.abs(o.t - s.t) <= 100) {
        sum += o.v
        k++
      }
    }
    dev.push(s.v - sum / Math.max(1, k))
  }
  const n = v.length
  const mean = v.reduce((a, s) => a + s.v, 0) / Math.max(1, n)
  const sd = Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / Math.max(1, n))
  const spike = dev.reduce((m, d) => Math.max(m, Math.abs(d)), 0)
  const bad = dev.filter((d) => Math.abs(d) > RUN_SPEED * 0.25).length
  return { mean, sd, spike, badPct: (100 * bad) / Math.max(1, n), n }
}

const own = stats(F.ownX, F.ownZ)
const cam = stats(F.camX, F.camZ)
// The walker as the watcher sees it. Its corners reach the watcher after the interpolation delay,
// so no frames are skipped; compare runs with each other, not with `own`.
const t0w = legStarts[0] ?? 0
const tEnd = (legStarts.at(-1) ?? 0) + legMs
const rem = stats(10, 11, watched, (t) => t > t0w + 500 && t < tEnd)
const cpu = rows.map((r) => r[F.cpu] ?? 0).sort((a, b) => a - b)
const p95 = cpu[Math.floor(cpu.length * 0.95)] ?? 0
const corr = {
  smooth: c1.smooth - c0.smooth,
  snap: c1.snap - c0.snap,
  meanCm: ((c1.sumM - c0.sumM) / Math.max(1, c1.smooth - c0.smooth + c1.snap - c0.snap)) * 100,
  maxCm: c1.maxM * 100,
}
const r2 = (x: number): number => Math.round(x * 100) / 100
const out = {
  mode: MODE,
  rtt: RTT,
  jitter: JITTER,
  hz: HZ,
  frames: rows.length,
  own: { mean: r2(own.mean), sd: r2(own.sd), spike: r2(own.spike), badPct: r2(own.badPct) },
  cam: { mean: r2(cam.mean), sd: r2(cam.sd), spike: r2(cam.spike), badPct: r2(cam.badPct) },
  ...(WATCH
    ? {
        remote: {
          mean: r2(rem.mean),
          sd: r2(rem.sd),
          spike: r2(rem.spike),
          badPct: r2(rem.badPct),
          n: rem.n,
        },
      }
    : {}),
  corr: {
    smooth: corr.smooth,
    snap: corr.snap,
    meanCm: r2(corr.meanCm),
    maxCm: r2(corr.maxCm),
  },
  cpuP95: r2(p95),
}
if (JSON_OUT) {
  console.log(JSON.stringify(out))
} else {
  console.log(
    `${MODE} rtt=${RTT} jitter=${JITTER} ${HZ}Hz  frames=${rows.length}\n` +
      `  own  speed ${out.own.mean} m/s  sd ${out.own.sd}  spike ${out.own.spike}  bad ${out.own.badPct}%\n` +
      `  cam  speed ${out.cam.mean} m/s  sd ${out.cam.sd}  spike ${out.cam.spike}  bad ${out.cam.badPct}%\n` +
      (WATCH
        ? `  remote speed ${r2(rem.mean)} m/s  sd ${r2(rem.sd)}  spike ${r2(rem.spike)}  bad ${r2(rem.badPct)}%  (${rem.n} frames)\n`
        : '') +
      `  corrections smooth ${corr.smooth} snap ${corr.snap} mean ${out.corr.meanCm} cm max ${out.corr.maxCm} cm\n` +
      `  cpu p95 ${out.cpuP95} ms`,
  )
}
