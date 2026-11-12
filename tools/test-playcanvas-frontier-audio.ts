// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: gait cadence and ambience timers are measured in real time
/**
 * Frontier world audio in real Chrome: every sound loads; footsteps follow the gait and the
 * surface underfoot and stay inside their readable range; authoritative strikes pick the struck
 * material; hit markers, near misses, foley and the ambience fire; walls muffle what they hide.
 * The page's actual output is recorded for listening (`OW_EVIDENCE/<scene>.wav`).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, type Page } from 'playwright'
import { impactMaterial, stepSurface } from '../src/experiments/out-west/client/audio-surfaces.ts'
import type {
  FrontierAudio,
  PlayedSound,
} from '../src/experiments/out-west/client/frontier-audio.ts'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import { RANGES, SOUNDS, STEP_SOUND } from '../src/experiments/out-west/client/frontier-sounds.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'
import { SHOT_HIT, SHOT_WALL } from '../src/experiments/out-west/contract/town.ts'
import { buildGrid } from '../src/experiments/out-west/ffa/sim/layout.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-frontier-audio'
await mkdir(output, { recursive: true })

interface Point {
  x: number
  y: number
  z: number
}

/** Tee everything that reaches the speakers into a recorder, before the game makes its context. */
const TAP = `(() => {
  const connect = AudioNode.prototype.connect
  const disconnect = AudioNode.prototype.disconnect
  // mirror every link to the speakers, and every unlinking of it, onto the tap and the meter
  AudioNode.prototype.disconnect = function (...args) {
    const ctx = this.context
    const all = args.length === 0
    if ((all || args[0] instanceof AudioDestinationNode) && ctx.__tap && this.__tapped) {
      this.__tapped = false
      disconnect.call(this, ctx.__tap)
      disconnect.call(this, ctx.__meter)
    }
    return all ? disconnect.call(this) : disconnect.apply(this, args)
  }
  AudioNode.prototype.connect = function (destination, ...rest) {
    const result = connect.call(this, destination, ...rest)
    if (destination instanceof AudioDestinationNode) {
      const ctx = destination.context
      if (!ctx.__tap) {
        ctx.__tap = ctx.createMediaStreamDestination()
        ctx.__meter = ctx.createAnalyser()
        ctx.__meter.fftSize = 2048
        const frame = new Float32Array(2048)
        globalThis.__peak = 0
        setInterval(() => {
          ctx.__meter.getFloatTimeDomainData(frame)
          for (const v of frame) globalThis.__peak = Math.max(globalThis.__peak, Math.abs(v))
        }, 20)
        globalThis.__direct = {}
      }
      globalThis.__tap = ctx.__tap
      const kind = this.constructor.name
      globalThis.__direct[kind] = (globalThis.__direct[kind] ?? 0) + 1
      if (!this.__tapped) {
        this.__tapped = true
        connect.call(this, ctx.__tap)
        connect.call(this, ctx.__meter)
      }
    }
    return result
  }
  globalThis.__startRecording = () => {
    const chunks = []
    const rec = new MediaRecorder(globalThis.__tap.stream, { mimeType: 'audio/webm;codecs=opus' })
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.start(250)
    globalThis.__stopRecording = () => new Promise((done) => {
      rec.onstop = async () => {
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        done(btoa(s))
      }
      rec.stop()
    })
  }
})()`

/** The harness closes every socket (Vite's HMR one too); engine debug asserts are not failures. */
const BENIGN = /vite|ASSERT FAILED/iu
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) {
    failures.push(what)
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
})

async function open(spawn: string, bots: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on('pageerror', (error) =>
    errors.push(`${error.message} ${error.stack?.split('\n')[1]?.trim()}`),
  )
  page.on('console', (m) => {
    if (m.type() === 'error' && !BENIGN.test(m.text())) {
      errors.push(m.text())
    }
  })
  await page.addInitScript({ content: TAP })
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=${bots}&cluster&seed=7&spawn=${spawn}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport | undefined),
    undefined,
    {
      timeout: 90_000,
    },
  )
  await page.waitForFunction(() =>
    Boolean((Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined)?.context),
  )
  await page.evaluate(() => {
    const audio = Reflect.get(globalThis, '__frontierAudio') as FrontierAudio
    const update = audio.update.bind(audio)
    const cost = { ms: 0, frames: 0 }
    Reflect.set(globalThis, '__audioCost', cost)
    audio.update = (...args) => {
      const t = performance.now()
      update(...args)
      cost.ms += performance.now() - t
      cost.frames++
    }
    ;(Reflect.get(globalThis, '__startRecording') as () => void)()
  })
  return { page, errors }
}

const log = (page: Page, since = 0) =>
  page.evaluate(
    (t) =>
      ((Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined)?.log ?? []).filter(
        (e) => e.t >= t,
      ),
    since,
  )
const clock = (page: Page) =>
  page.evaluate(
    () => (Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined)?.clock ?? 0,
  )
const self = (page: Page) =>
  page.evaluate(() => {
    const s = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const p = s.world.players[s.selfSlot]
    return { slot: s.selfSlot, x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0, alive: Boolean(p?.alive) }
  })

/** The movement key with the longest clear run from here (each tried there and back). */
async function clearWay(page: Page, keys = ['KeyW', 'KeyS', 'KeyA', 'KeyD']): Promise<string> {
  const back: Record<string, string> = { KeyW: 'KeyS', KeyS: 'KeyW', KeyA: 'KeyD', KeyD: 'KeyA' }
  let best = { key: 'KeyW', run: -1 }
  for (const key of keys) {
    const a = await self(page)
    await page.keyboard.down(key)
    await page.waitForTimeout(900)
    await page.keyboard.up(key)
    const b = await self(page)
    const run = Math.hypot(b.x - a.x, b.z - a.z)
    await page.keyboard.down(back[key] as string)
    await page.waitForTimeout(900)
    await page.keyboard.up(back[key] as string)
    if (run > best.run) {
      best = { key, run }
    }
  }
  return best.key
}

/** An authoritative shot from another rider, arriving through the real event path. */
async function strike(
  page: Page,
  shot: { from: Point; end: Point; flags: number; shotId: number },
) {
  await page.evaluate(({ from, end, flags, shotId }) => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const shooter = session.world.players.find((p) => p && p.id !== session.selfSlot)
    ;(Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport | undefined)?.event({
      type: 'shot',
      shotId,
      spawnTick: shooter?.spawnTick ?? 0,
      shooter: shooter?.id ?? 1,
      aim: 0,
      range: 10,
      target: -1,
      flags,
      x: from.x,
      z: from.z,
      y: Math.round(end.y * 10),
      origin: from,
      end,
      pellets: [],
    })
  }, shot)
  await page.waitForTimeout(160)
}

/** The nearest point of each material within `radius` of `at` (a 0.5 m scan of the authored town). */
const GRID = buildGrid()
function materials(at: Point, radius: number): Map<string, Point> {
  const found = new Map<string, { d: number; p: Point }>()
  for (let x = at.x - radius; x <= at.x + radius; x += 0.5) {
    for (let z = at.z - radius; z <= at.z + radius; z += 0.5) {
      for (const y of [0.02, 1.2]) {
        const m = impactMaterial({ x, y, z }, GRID)
        const d = Math.hypot(x - at.x, z - at.z)
        if (m && m !== 'glass' && d > 2 && d < (found.get(m)?.d ?? radius)) {
          found.set(m, { d, p: { x, y, z } })
        }
      }
    }
  }
  return new Map([...found].map(([m, v]) => [m, v.p]))
}

async function finish(page: Page, scene: string, errors: string[]) {
  const all = await log(page)
  const fps = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        let frames = 0
        const t0 = performance.now()
        const tick = () => {
          frames++
          if (performance.now() - t0 < 3000) {
            requestAnimationFrame(tick)
          } else {
            done((frames * 1000) / (performance.now() - t0))
          }
        }
        requestAnimationFrame(tick)
      }),
  )
  const cost = await page.evaluate(
    () => Reflect.get(globalThis, '__audioCost') as { ms: number; frames: number } | undefined,
  )
  const out = await page.evaluate(() => ({
    peak: Reflect.get(globalThis, '__peak') as number,
    direct: Reflect.get(globalThis, '__direct') as Record<string, number>,
  }))
  console.log(
    `${scene}: output peak ${(20 * Math.log10(out.peak)).toFixed(1)} dBFS; straight to the speakers: ${JSON.stringify(out.direct)}`,
  )
  check(out.peak <= 1, `${scene}: the output never clips (peak ${out.peak.toFixed(3)})`)
  const audio = await page.evaluate(
    () =>
      (Reflect.get(globalThis, '__stopRecording') as (() => Promise<string>) | undefined)?.() ?? '',
  )
  await writeFile(`${output}/${scene}.webm`, Buffer.from(audio, 'base64'))
  await writeFile(`${output}/${scene}.log.json`, JSON.stringify(all, null, 1))
  const ms = cost ? cost.ms / Math.max(1, cost.frames) : 0
  console.log(
    `${scene}: ${all.length} plays, ${fps.toFixed(0)} fps, audio update ${ms.toFixed(3)} ms/frame`,
  )
  check(ms < 0.5, `${scene}: world audio update stays under 0.5 ms a frame (${ms.toFixed(3)})`)
  check(errors.length === 0, `${scene}: no page errors (${errors.slice(0, 3).join(' | ')})`)
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport | undefined)?.destroy(),
  )
  await page.close()
  return { plays: all.length, fps, ms }
}

const steps = new Set<string>(Object.values(STEP_SOUND))
const stepsOf = (entries: PlayedSound[], source: string) =>
  entries.filter((e) => e.source === source && steps.has(e.name))

// ---------------------------------------------------------------- the main street, with bots
{
  const { page, errors } = await open('72,66', 7)
  const missing = await page.evaluate(
    (all: string[]) =>
      all.filter(
        (n) =>
          !(Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined)?.assetOf(
            n as never,
          ),
      ),
    Object.keys(SOUNDS),
  )
  check(missing.length === 0, `every Frontier sound loads (missing: ${missing.join(', ')})`)
  await page.waitForTimeout(2500)
  const beds = await page.evaluate(() => {
    const game = Reflect.get(
      (Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined) ?? {},
      'game',
    ) as {
      stage: {
        findByName: (
          n: string,
        ) => { sound?: { slots: Record<string, { isPlaying: boolean }> } } | null
      }
    }
    return ['wind', 'murmur', 'loco'].filter((n) =>
      Object.values(game.stage.findByName(`bed-${n}`)?.sound?.slots ?? {}).some((s) => s.isPlaying),
    )
  })
  check(beds.length === 3, `the wind, saloon murmur and depot loco beds loop (${beds.join(' ')})`)

  const me = await self(page)
  const feet = `feet-${me.slot}`
  const t0 = await clock(page)
  await page.keyboard.press('Space')
  await page.waitForTimeout(1200)
  const jump = (await log(page, t0)).filter((e) => e.source === feet).map((e) => e.name)
  check(jump.filter((n) => n === 'cloth').length >= 2, `jump and landing foley (${jump.join(' ')})`)

  const t1 = await clock(page)
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport | undefined)?.tap(1),
  )
  await page.waitForTimeout(900)
  await page.keyboard.press('KeyR')
  await page.waitForTimeout(900)
  const own = (await log(page, t1)).map((e) => e.name)
  check(
    own.includes('shot') && own.includes('tail'),
    `own revolver: close report and tail (${own.join(' ')})`,
  )
  check(own.includes('reload'), 'reload foley')

  const here = await self(page)
  const ear = await page.evaluate(() => {
    const at = (Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined)?.listener
    return { x: at?.x ?? 0, y: at?.y ?? 0, z: at?.z ?? 0 }
  })
  const targets = materials(here, 40)
  let shotId = 1_000_000
  for (const [material, end] of targets) {
    const t = await clock(page)
    const from = { x: end.x + (ear.x - end.x) * 0.3, y: 1.4, z: end.z + (ear.z - end.z) * 0.3 }
    await strike(page, { from, end, flags: SHOT_WALL, shotId: shotId++ })
    const heard = (await log(page, t)).find((e) => e.name === material)
    check(
      Boolean(heard),
      `bullet on ${material} at ${end.x},${end.y},${end.z} plays the ${material} strike`,
    )
    const hidden = await page.evaluate(
      (ray) => {
        const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
        return session.cameraTrace?.(ray.ear as never, ray.end as never)
      },
      { ear, end },
    )
    if (heard) {
      console.log(
        `     ${material}: ${heard.distance.toFixed(1)} m, lowpass ${heard.lowpass}, occluded ${heard.occluded}, wall between ${Boolean(hidden)}`,
      )
    }
  }
  const behind = await page.evaluate((from) => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2
      const far = { x: from.x + Math.cos(a) * 40, y: from.y, z: from.z + Math.sin(a) * 40 }
      const hit = session.cameraTrace?.(from as never, far as never)
      const d = hit ? Math.hypot(hit.x - from.x, hit.z - from.z) : 99
      if (hit && d > 4 && d < 20) {
        return { x: hit.x + Math.cos(a) * 6, y: from.y, z: hit.z + Math.sin(a) * 6, wall: d }
      }
    }
    return null
  }, ear)
  if (behind) {
    const t = await clock(page)
    await strike(page, {
      from: { x: behind.x, y: behind.y + 3, z: behind.z },
      end: behind,
      flags: SHOT_WALL,
      shotId: shotId++,
    })
    const strikes = new Set(['stone', 'metal', 'water', 'soft', 'wood', 'dirt'])
    const muffled = (await log(page, t)).find((e) => strikes.has(e.name))
    check(
      Boolean(muffled?.occluded && muffled.lowpass < 2000),
      `a strike 6 m behind a wall ${behind.wall.toFixed(1)} m away is muffled (${muffled?.name} lowpass ${muffled?.lowpass})`,
    )
  }
  const rider = await page.evaluate(() => {
    const s = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const p = s.world.players.find((q) => q && q.id !== s.selfSlot && q.alive)
    return p ? { x: p.x, y: p.y + 1.2, z: p.z } : null
  })
  if (rider) {
    const t = await clock(page)
    await strike(page, {
      from: { x: rider.x + 3, y: 1.4, z: rider.z },
      end: rider,
      flags: SHOT_HIT,
      shotId: shotId++,
    })
    check(
      (await log(page, t)).some((e) => e.name === 'body'),
      'bullet on a rider plays the body hit',
    )
  }
  // a bot's own crack may have just taken the throttle window: try a few rounds
  let whiz: string[] = []
  for (let round = 0; round < 4 && !whiz.includes('crack'); round++) {
    const t = await clock(page)
    const past = { x: ear.x + 0.6, y: ear.y, z: ear.z + 0.6 }
    await strike(page, {
      from: { x: ear.x - 30, y: ear.y, z: ear.z - 30 },
      end: { x: past.x + 20, y: ear.y, z: past.z + 20 },
      flags: 0,
      shotId: shotId++,
    })
    whiz = (await log(page, t)).map((e) => e.name)
  }
  check(
    whiz.includes('crack') && whiz.includes('flyby'),
    `near miss cracks past the ear (${whiz.join(' ')})`,
  )
  const t3 = await clock(page)
  await page.evaluate((slot) => {
    const game = Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport | undefined
    game?.event({ type: 'damage', victim: 2, attacker: slot, amount: 40, hp: 60 })
    game?.event({ type: 'kill', victim: 2, killer: slot, flags: 0, bounty: 0 })
  }, here.slot)
  await page.waitForTimeout(200)
  const confirm = (await log(page, t3)).map((e) => e.name)
  check(
    confirm.includes('hitMarker') && confirm.includes('kill'),
    `hit marker and kill confirm (${confirm.join(' ')})`,
  )

  // the bots fight on; the town's life plays on its timers
  await page.waitForTimeout(20_000)
  const late = await log(page)
  const names = new Set(late.map((e) => e.name))
  const others = late.filter(
    (e) => e.source.startsWith('feet-') && e.source !== feet && steps.has(e.name),
  )
  check(others.length > 0, `other riders' footsteps are heard (${others.length})`)
  check(
    others.every((e) => e.distance <= RANGES.step.cull + 0.5),
    `no footsteps beyond ${RANGES.step.cull} m (max ${Math.max(0, ...others.map((e) => e.distance)).toFixed(1)})`,
  )
  const muffled = late.filter((e) => e.occluded)
  console.log(
    `     occluded plays: ${muffled.length} (${[...new Set(muffled.map((e) => e.name))].join(' ')})`,
  )
  const life = ['crow', 'dog', 'horse', 'hawk', 'creak', 'whistle'].filter((n) =>
    names.has(n as PlayedSound['name']),
  )
  check(life.length > 0, `town life plays (${life.join(' ')})`)
  await finish(page, 'street', errors)
}

// ---------------------------------------------------------------- the creek
{
  const { page, errors } = await open('47,5', 0)
  await page.waitForTimeout(1500)
  const me = await self(page)
  const feet = `feet-${me.slot}`
  for (const [gait, held, lo, hi, pace, hold] of [
    ['walk', [], 0.26, 0.6, 4.5, 1.8],
    ['sprint', ['ShiftLeft'], 0.2, 0.45, 6.5, 1.8],
    ['crouch', ['KeyC'], 0.35, 0.8, 2, 2.6],
  ] as const) {
    // sprinting is forward only
    const keys = [await clearWay(page, gait === 'sprint' ? ['KeyW'] : undefined), ...held]
    const t = await clock(page)
    const before = await self(page)
    for (const k of keys) {
      await page.keyboard.down(k)
    }
    await page.waitForTimeout(hold * 1000)
    for (const k of [...keys].reverse()) {
      await page.keyboard.up(k)
    }
    const after = await self(page)
    const moved = Math.hypot(after.x - before.x, after.z - before.z)
    check(moved / hold > pace, `${gait}: at pace (${(moved / hold).toFixed(1)} m/s)`)
    const mine = stepsOf(await log(page, t + 0.5), feet)
    const gaps = mine.slice(1).map((e, i) => e.t - (mine[i] as PlayedSound).t)
    const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)
    check(mine.length >= 3, `${gait}: own footsteps play (${mine.length})`)
    check(mean >= lo && mean <= hi, `${gait}: cadence ${mean.toFixed(2)} s within ${lo}-${hi}`)
    const wrong = mine.filter((e) => {
      const at = e.at as Point
      return e.name !== STEP_SOUND[stepSurface(at.x, at.y - 0.05, at.z)]
    })
    check(
      wrong.length === 0,
      `${gait}: every step matches the surface underfoot (${mine.map((e) => e.name).join(' ')})`,
    )
    const level = mine.reduce((a, e) => a + e.volume, 0) / Math.max(1, mine.length)
    console.log(`     ${gait} mean step level ${level.toFixed(3)}`)
  }

  let wet = stepsOf(await log(page), feet).some((e) => e.name === 'stepWater')
  for (const key of wet ? [] : ['KeyS', 'KeyW', 'KeyA', 'KeyD']) {
    const t = await clock(page)
    await page.keyboard.down(key)
    await page.waitForTimeout(1600)
    await page.keyboard.up(key)
    wet ||= stepsOf(await log(page, t), feet).some((e) => e.name === 'stepWater')
  }
  check(wet, 'wading the creek plays water footsteps')
  const here = await self(page)
  const water = materials(here, 30).get('water')
  if (water) {
    const t = await clock(page)
    await strike(page, {
      from: { x: here.x, y: 1.5, z: here.z },
      end: water,
      flags: SHOT_WALL,
      shotId: 2_000_000,
    })
    check(
      (await log(page, t)).some((e) => e.name === 'water'),
      'bullet in the creek plays the water strike',
    )
  } else {
    check(false, 'a creek point within 30 m of the creek spawn')
  }
  await finish(page, 'creek', errors)
}

await browser.close()
if (failures.length > 0) {
  console.error(`${failures.length} failed`)
  process.exit(1)
}
console.log('Frontier world audio passed')
