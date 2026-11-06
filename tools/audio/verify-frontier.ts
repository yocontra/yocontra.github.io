// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear test script
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: a real-time town: waits are game beats, not flaky selectors
/**
 * Plays the practice Frontier town (loopback, 15 bots) in real Chrome and reads the `#audiodebug`
 * meters and timeline (`__owAudio`), driving your gunslinger with the dev autopilot
 * (`__frontierPilot`, `?debug`).
 *
 *   PLAYWRIGHT=/abs/path/to/node_modules/playwright bun tools/audio/verify-frontier.ts [baseUrl] [--bots=15]
 *
 * A full town (15 bots) is the stress test for voices; a quiet one (`--bots=1`) is where the
 * pickups, the strongbox and the bank are reliably reachable (bots never mint bounties).
 *
 * Walks the street and the saloon porch (dirt and wood steps), takes the porch rifle and the
 * store's shotgun and fires both, fires and reloads the revolver, throws dynamite, cracks the
 * strongbox, picks up any bag and banks the carry. Then reports which cues fired and how often, the
 * fuse's start and stop around the blast, the most voices of any one sample alive at once, the
 * output peak, NaN frames and decoded memory.
 */

interface Frame {
  t: number
  tap: string
  peak: number
  rms: number
  bad: boolean
}
interface Ev {
  t: number
  name: string
  args: string
}
interface PageLike {
  goto: (url: string) => Promise<unknown>
  waitForFunction: (fn: string, arg?: unknown, opts?: { timeout?: number }) => Promise<unknown>
  evaluate: <T>(fn: string) => Promise<T>
  mouse: { click: (x: number, y: number) => Promise<void> }
  keyboard: { down: (k: string) => Promise<void>; up: (k: string) => Promise<void> }
  waitForTimeout: (ms: number) => Promise<void>
}
interface Pw {
  chromium: {
    launch: (o: unknown) => Promise<{
      newPage: (o: unknown) => Promise<PageLike>
      close: () => Promise<void>
    }>
  }
}
interface Debug {
  you: number
  alive: boolean
  x: number
  z: number
  carried: number
  banked: number
  weapon: { weapon: number; rounds: number; dynamite: boolean }
  others: { id: number; x: number; z: number; alive: boolean }[]
  bags: { id: number; x: number; z: number }[]
  pickups: { kind: string; x: number; z: number; up: boolean }[]
  strongbox: { spot: number; state: number } | null
}

const BTN_FIRE = 1
const BTN_RELOAD = 8
const BTN_INTERACT = 16
const BTN_THROW = 128
const town = (await Bun.file(
  new URL('../../src/experiments/out-west/ffa/town.layout.json', import.meta.url),
).json()) as { strongboxes: { x: number; z: number }[] }
const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4353'
const bots = Number(process.argv.find((a) => a.startsWith('--bots='))?.slice(7) ?? '15')
const pwPath = process.env.PLAYWRIGHT ?? 'playwright'
const { chromium } = (await import(pwPath)) as Pw
const f1 = (n: number) => n.toFixed(1)

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=metal'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(`${base}/experiments/out-west/frontier/?bots=${bots}&debug#audiodebug`)
await page.waitForFunction('typeof globalThis.__frontier === "function"', undefined, {
  timeout: 60_000,
})
await page.waitForFunction(
  'globalThis.__frontier().you >= 0 && globalThis.__frontier().alive',
  undefined,
  { timeout: 90_000 },
)
await page.mouse.click(640, 360)
await page.waitForFunction('globalThis.__owAudio !== undefined', undefined, { timeout: 30_000 })
await page.waitForFunction(
  // biome-ignore lint/security/noSecrets: a JS expression for the page, not a secret
  'globalThis.__owAudioEngine?.has("rifleFire") && globalThis.__owAudioEngine?.has("explosion")',
  undefined,
  { timeout: 30_000 },
)
console.log(
  `${bots} bots; frontier pack decoded:`,
  await page.evaluate<string>('JSON.stringify(globalThis.__owAudio.stats())'),
)

const dbg = () => page.evaluate<Debug>('globalThis.__frontier()')
const pilot = (js: string) => page.evaluate<unknown>(`globalThis.__frontierPilot.${js}`)
// The most live voices of one sample, sampled every 100 ms from the engine (debug only).
await page.evaluate(`(() => {
  const e = globalThis.__owAudioEngine
  globalThis.__stack = {}
  setInterval(() => {
    const now = e.ctx.currentTime
    const n = {}
    for (const v of e.voices) {
      if (!v.done && v.end > now) n[v.name] = (n[v.name] ?? 0) + 1
    }
    for (const [k, c] of Object.entries(n)) globalThis.__stack[k] = Math.max(globalThis.__stack[k] ?? 0, c)
  }, 100)
})()`)

/** Walk to (x, z); resolves when the path is done (or after `ms`). */
async function walkTo(x: number, z: number, ms = 90_000): Promise<boolean> {
  const d = await dbg()
  const ok = (await pilot(`go(${x}, ${z})`)) as boolean
  if (!ok) {
    console.log(`  no path from ${f1(d.x)},${f1(d.z)} to ${x},${z}`)
    return false
  }
  const end = Date.now() + ms
  while (Date.now() < end && (await pilot('walking()'))) {
    await page.waitForTimeout(200)
  }
  // the path ends on a nav cell: step the last metre with the keys (WASD move along the world axes)
  for (let i = 0; i < 25; i++) {
    const p = await dbg()
    const dx = x - p.x
    const dz = z - p.z
    if (Math.hypot(dx, dz) < 0.5) {
      break
    }
    const keys = [
      ...(Math.abs(dx) > 0.3 ? [dx > 0 ? 'KeyD' : 'KeyA'] : []),
      ...(Math.abs(dz) > 0.3 ? [dz > 0 ? 'KeyS' : 'KeyW'] : []),
    ]
    for (const k of keys) {
      await page.keyboard.down(k)
    }
    await page.waitForTimeout(Math.min(150, Math.hypot(dx, dz) * 120))
    for (const k of keys) {
      await page.keyboard.up(k)
    }
    await page.waitForTimeout(150)
  }
  const at = await dbg()
  console.log(
    `  at ${f1(at.x)},${f1(at.z)} (${f1(Math.hypot(x - at.x, z - at.z))} m from ${x},${z})`,
  )
  return true
}

/** Respawned after a death: wait until alive again. */
async function alive(): Promise<void> {
  await page.waitForFunction('globalThis.__frontier().alive', undefined, { timeout: 30_000 })
}

async function fire(times: number, gapMs: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await pilot(`tap(${BTN_FIRE})`)
    await page.waitForTimeout(gapMs)
  }
}

/** Walk to the nearest standing pickup of `kind` (the porch rifle first: it is on boardwalk). */
async function take(kind: string): Promise<boolean> {
  for (let tries = 0; tries < 3; tries++) {
    await alive()
    const d = await dbg()
    const spot = d.pickups
      .filter((p) => p.kind === kind && p.up)
      .sort((a, b) => Math.hypot(a.x - d.x, a.z - d.z) - Math.hypot(b.x - d.x, b.z - d.z))[0]
    if (spot) {
      console.log(`walk: to the ${kind} at ${spot.x},${spot.z}`)
      await walkTo(spot.x, spot.z)
      await page.waitForTimeout(500)
      const w = (await dbg()).weapon
      if (kind === 'dynamite' ? w.dynamite : w.weapon !== 0) {
        console.log('  got it:', JSON.stringify(w))
        return true
      }
    } else {
      // all taken: they respawn 45 s later
      await page.waitForTimeout(5000)
    }
  }
  return false
}

// 0. Money: bots never mint bounties, so crack the strongbox (the first turns up a minute in),
// pick up any bag lying about, then bank the carry at the teller's window.
console.log('money: wait for the strongbox')
await page.waitForFunction('globalThis.__frontier().strongbox?.state > 0', undefined, {
  timeout: 240_000,
})
for (let tries = 0; tries < 3 && (await dbg()).carried === 0; tries++) {
  await alive()
  const spot = (await dbg()).strongbox?.spot ?? -1
  const box = town.strongboxes[spot]
  if (!box) {
    break
  }
  console.log(`walk: to the strongbox at ${box.x},${box.z}`)
  await walkTo(box.x, box.z + 1)
  await pilot(`tap(${BTN_INTERACT})`)
  await page.waitForTimeout(4000)
}
const bags = (await dbg()).bags
if (bags[0]) {
  console.log('walk: to a bag')
  await walkTo(bags[0].x, bags[0].z, 20_000)
  await page.waitForTimeout(400)
}
console.log('walk: to the bank window; carrying', (await dbg()).carried)
await alive()
await walkTo(64.5, 81, 90_000)
for (let tries = 0; tries < 3 && (await dbg()).carried > 0; tries++) {
  await pilot(`tap(${BTN_INTERACT})`)
  await page.waitForTimeout(3000)
}
console.log('  carrying after the window', (await dbg()).carried)

// 1. The street (dirt) to the saloon porch (wood), where a rifle waits.
console.log('walk: street to the saloon porch')
await walkTo(56, 55)
if (await take('rifle')) {
  await pilot('aimPoint(56, 75)')
  await fire(3, 1100)
}

// 2. A shotgun.
if (await take('shotgun')) {
  await pilot('aimPoint(50, 100)')
  await fire(2, 900)
}

// 3. The revolver: a few shots and a reload.
await alive()
await pilot('aimPoint(40, 100)')
await fire(3, 400)
await pilot(`tap(${BTN_RELOAD})`)
await page.waitForTimeout(2000)

// 4. Dynamite, lobbed a few metres ahead.
if (await take('dynamite')) {
  const d = await dbg()
  await pilot(`aimPoint(${d.x + 6}, ${d.z})`)
  await pilot(`tap(${BTN_THROW})`)
  await page.waitForTimeout(3500)
}

const frames = await page.evaluate<Frame[]>('globalThis.__owAudio.frames')
const events = await page.evaluate<Ev[]>('globalThis.__owAudio.events')
const stack = await page.evaluate<Record<string, number>>('globalThis.__stack')
const stats = await page.evaluate<Record<string, number>>('globalThis.__owAudio.stats()')
await browser.close()

const plays = new Map<string, number>()
for (const e of events) {
  if (e.name === 'play' || e.name === 'loop' || e.name === 'loopStop' || e.name === 'playSong') {
    const key = `${e.name} ${e.args.split(',')[0]}`
    plays.set(key, (plays.get(key) ?? 0) + 1)
  }
}
const want = [
  'playSong frontier',
  'loop saloon',
  'loop saloonPiano',
  'loop wind',
  'play fire',
  'play rifleFire',
  'play shotgunFire',
  'play rifleLever',
  'play shotgunLoad',
  'play cocking',
  'loop fuse',
  'loopStop fuse',
  'play explosion',
  'play dirtsteps',
  'play woodsteps',
  'play hitBody',
  'play hitWood',
  'play hitDirt',
  'play ricochet',
  'play coin',
  'play coins',
  'play deposit',
  'play register',
  'play respawn',
]
console.log('\ncues (count):')
for (const k of want) {
  console.log(`  ${k.padEnd(22)} ${plays.get(k) ?? 0}`)
}
const fuse = events.find((e) => e.name === 'loop' && e.args.startsWith('fuse'))
const blast = events.find((e) => e.name === 'play' && e.args.startsWith('explosion'))
const fuseStop = events.find((e) => e.name === 'loopStop' && e.args.startsWith('fuse'))
if (fuse && blast && fuseStop) {
  console.log(
    `fuse: lit at ${f1(fuse.t)} s, blast ${Math.round((blast.t - fuse.t) * 1000)} ms later, hiss stopped ${Math.round((fuseStop.t - blast.t) * 1000)} ms after the blast`,
  )
}
const bells = events.filter((e) => e.name === 'play' && e.args.startsWith('bell'))
console.log(
  `bells: ${bells.length} (positional: ${bells.filter((e) => e.args.includes('"pos"')).length})`,
)
console.log(`dedupes (re-trigger guard): ${events.filter((e) => e.name === 'dedupe').length}`)
console.log(
  'most live voices of one sample:',
  Object.entries(stack)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' '),
)
const out = frames.filter((f) => f.tap === 'out')
const peak = Math.max(...out.map((f) => f.peak))
const loud = out.filter((f) => f.peak > -1).length
console.log(`output peak ${f1(peak)} dBFS; frames above -1 dBFS: ${loud} of ${out.length}`)
for (const b of events.filter((e) => e.name === 'play' && e.args.startsWith('explosion'))) {
  const w = out.filter((f) => f.t >= b.t && f.t < b.t + 1.5)
  if (w.length > 0) {
    console.log(`explosion at ${f1(b.t)} s: peak ${f1(Math.max(...w.map((f) => f.peak)))} dBFS`)
  }
}
console.log(`bad (NaN) frames: ${frames.filter((f) => f.bad).length} of ${frames.length}`)
console.log('stats', JSON.stringify(stats))

export {}
