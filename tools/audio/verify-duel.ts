// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear test script
// biome-ignore-all lint/performance/noAwaitInLoops: polling a live page, one probe at a time
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: a real-time duel: waits are game beats, not flaky selectors
// biome-ignore-all lint/style/useNamedCaptureGroup: one-number captures from debug event strings
/**
 * Plays a practice duel in real Chrome and reads the `#audiodebug` meters (`__owAudio`).
 *
 *   PLAYWRIGHT=/abs/path/to/node_modules/playwright bun tools/audio/verify-duel.ts [baseUrl] [--loops]
 *
 * Playwright is not a repo dependency: install it anywhere (`bun add playwright`) and point
 * PLAYWRIGHT at it. Uses `channel: 'chrome'`.
 *
 * Reports, for the call: when the bell's strike reaches the output relative to the call, and how far
 * the SFX bus (the bell) stands above music and ambience in the 700 ms after it; for the round: the
 * output peak, any NaN frames, and decoded memory. `--loops` also plays the tension bed through a
 * loop seam and reports the seam's alignment and any level dip.
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
  mouse: {
    click: (x: number, y: number) => Promise<void>
    down: () => Promise<void>
    up: () => Promise<void>
    move: (x: number, y: number) => Promise<void>
  }
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

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4350'
const SHOT = /^(fire|fireBig)/u
const loops = process.argv.includes('--loops')
const hashExtra = process.argv.find((a) => a.startsWith('#'))?.slice(1) ?? ''
const pwPath = process.env.PLAYWRIGHT ?? 'playwright'
const { chromium } = (await import(pwPath)) as Pw

const rmsDb = (xs: number[]) =>
  xs.length > 0 ? 10 * Math.log10(xs.reduce((a, d) => a + 10 ** (d / 10), 0) / xs.length) : -200
const f1 = (n: number) => n.toFixed(1)

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(
  `${base}/experiments/out-west/#level=1&audiodebug${hashExtra ? `&${hashExtra}` : ''}`,
)
await page.waitForTimeout(1500)
await page.mouse.move(640, 360)
await page.mouse.click(640, 360)
await page.waitForFunction('globalThis.__owAudio !== undefined', undefined, { timeout: 30_000 })
const events = () => page.evaluate<Ev[]>('globalThis.__owAudio.events')
const since = async (): Promise<number> => (await events()).length
const waitEvent = async (pred: (e: Ev) => boolean, ms: number, from = 0): Promise<Ev | null> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const e = (await events()).slice(from).find(pred)
    if (e) {
      return e
    }
    await page.waitForTimeout(50)
  }
  return null
}
// The round starts (the stage cocks a gun); hold to walk until the wait phase ducks the music.
const stage = await waitEvent((e) => e.name === 'play' && e.args.startsWith('cocking'), 60_000)
await page.waitForTimeout(1200)
const mark = await since()
await page.mouse.down()
const wait = await waitEvent(
  (e) => e.name === 'musicLevel' && e.args.startsWith('-7'),
  60_000,
  mark,
)
await page.mouse.up()
const bell = await waitEvent(
  (e) => e.name === 'play' && e.args.startsWith('bell') && e.args.includes('"priority":true'),
  30_000,
  mark,
)
if (!(stage && wait && bell)) {
  console.error('no standoff / call reached', {
    stage: Boolean(stage),
    wait: Boolean(wait),
    bell: Boolean(bell),
  })
  await browser.close()
  process.exit(1)
}
// React like a quick human, then fire.
await page.waitForTimeout(260)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(4500)
const frames = await page.evaluate<Frame[]>('globalThis.__owAudio.frames')
const stats = await page.evaluate<Record<string, number>>('globalThis.__owAudio.stats?.() ?? {}')
const all = await events()

// The bell is scheduled: measure from its `when`, up to the player's own shot.
const tb = Number(bell.args.match(/"when":([\d.]+)/u)?.[1] ?? bell.t)
const shot = all.find((e) => e.name === 'play' && SHOT.test(e.args) && e.t > bell.t)
const bellEnd = Math.min(tb + 0.7, shot ? shot.t : tb + 0.7)
const win = (tap: string, a: number, b: number) =>
  frames.filter((f) => f.tap === tap && f.t >= a && f.t < b)
const sfxW = win('sfx', tb - 0.05, bellEnd)
const top = Math.max(...sfxW.map((f) => f.rms))
// The strike: first frame within 3 dB of the bell's loudest frame.
const strike = sfxW.find((f) => f.rms >= top - 3)
const before = (tap: string) => rmsDb(win(tap, tb - 0.7, tb - 0.05).map((f) => f.rms))
const during = (tap: string) => rmsDb(win(tap, tb, bellEnd).map((f) => f.rms))
const outPeak = Math.max(...frames.filter((f) => f.tap === 'out').map((f) => f.peak))
const bellPeak = Math.max(...win('out', tb, bellEnd).map((f) => f.peak))
const shotPeak = shot
  ? Math.max(...win('out', shot.t, shot.t + 0.5).map((f) => f.peak))
  : Number.NaN
console.log(
  `call → bell strike at the output: ${strike ? Math.round((strike.t - tb) * 1000) : 'n/a'} ms (meter frames are ~16 ms; analyser window 43 ms)`,
)
console.log(
  `bell window ${Math.round((bellEnd - tb) * 1000)} ms: out ${f1(during('out'))} dB rms (was ${f1(before('out'))} just before the call)`,
)
console.log(
  `  sfx (bell) ${f1(during('sfx'))}  music ${f1(during('music'))}  amb ${f1(during('amb'))} → bell clears music by ${f1(during('sfx') - during('music'))} dB, ambience by ${f1(during('sfx') - during('amb'))} dB`,
)
console.log(
  `output peak: bell ${f1(bellPeak)} dBFS, your shot ${f1(shotPeak)} dBFS, whole round ${f1(outPeak)} dBFS`,
)
console.log(`bad (NaN) frames: ${frames.filter((f) => f.bad).length} of ${frames.length}`)
console.log('stats', JSON.stringify(stats))

if (loops) {
  // Tension bed: start near the loop end and watch the seam.
  await page.evaluate(
    `(() => { const e = globalThis.__owAudioEngine; e.musicLevel(0, 0.1); e.musicLowpass(18000, 0.1); e.playSong('tension') })()`,
  )
  await page.waitForTimeout(1500)
  await page.evaluate(
    `(() => { const e = globalThis.__owAudioEngine; for (const s of e.streams) { if (s.spec.url.includes('tension')) { s.a.el.currentTime = s.spec.points.end - 4 } } })()`,
  )
  const seam = await waitEvent((e) => e.name === 'loopSeam' && e.args.includes('tension'), 15_000)
  await page.waitForTimeout(2000)
  const fr = await page.evaluate<Frame[]>('globalThis.__owAudio.frames')
  if (seam) {
    const around = fr.filter((f) => f.tap === 'music' && f.t > seam.t - 1 && f.t < seam.t + 1)
    const level = rmsDb(around.filter((f) => f.t < seam.t - 0.2).map((f) => f.rms))
    const dip = Math.min(
      ...around.filter((f) => Math.abs(f.t - seam.t - 0.1) < 0.2).map((f) => f.rms),
    )
    console.log(
      `loop seam (tension): ${seam.args} → alignment error ms, ready; music rms before ${f1(level)} dB, min at seam ${f1(dip)} dB`,
    )
  } else {
    console.log('loop seam: not reached')
  }
}
await browser.close()

export {}
