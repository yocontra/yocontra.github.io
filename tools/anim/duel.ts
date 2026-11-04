// biome-ignore-all lint/performance/noAwaitInLoops: states and frames run one after another on purpose
/** The animation audit's duel sections: the #lineup stage (duel/anim-stage.ts) and a played duel. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import type { BrowserContext, CDPSession, Page } from 'playwright'
import {
  all,
  type Expect,
  frameDone,
  judge,
  label,
  type Measure,
  motionOf,
  OUT,
  only,
  record,
  sheet,
  sleep,
  touch,
  tposes,
} from './lib.ts'

/** Each lineup state's evidence bar (duel/anim-stage.ts names them). */
const DUEL_EXPECT: Record<string, Expect> = {
  idle: { moves: 0.3 },
  'hub-variety': { moves: 8, offIdle: 10, layer: 'gesture' },
  'outfitter-turntable': { turns: 0.8 },
  'outfitter-tryon': { offIdle: 12, layer: 'gesture' },
  cock: { offIdle: 10, layer: 'gesture' },
  walk: { moves: 15, clip: 'Walk' },
  'walk-drunk': { moves: 15, clip: 'Walk', layer: 'sway' },
  'walk-talker': { moves: 15, clip: 'Walk', layer: 'gesture' },
  'turn-plant': { moves: 10, clip: 'Walk' },
  'wait-tension': { offIdle: 8, layer: 'gesture' },
  'wait-shaky': { offIdle: 8, layer: 'shake' },
  'fakeout-flinch': { offIdle: 15, layer: 'draw:flinch' },
  draw: { offIdle: 40, layer: 'draw:draw', clip: 'Idle_Gun_Pointing' },
  'draw-turn': { offIdle: 40, layer: 'draw:draw', turns: 2.5 },
  'aim-hold': { offIdle: 40, layer: 'draw:draw' },
  fire: { offIdle: 40, clip: 'Gun_Shoot' },
  'second-shot': { offIdle: 40, clip: 'Gun_Shoot' },
  fanning: { offIdle: 40, clip: 'Gun_Shoot', layer: 'draw:draw' },
  'two-gun-draw-fire': { offIdle: 40, clip: 'Gun_Shoot' },
  'hip-shot': { offIdle: 30, clip: 'Gun_Shoot' },
  'boss-spin': { offIdle: 40, layer: 'draw:draw' },
  'coward-backshot': { offIdle: 40, turns: 2.5, clip: 'Gun_Shoot' },
  'hit-nonlethal': { offIdle: 20, clip: 'HitRecieve' },
  'hit-2': { offIdle: 20, clip: 'HitRecieve_2' },
  'second-chance-flinch': { offIdle: 30, layer: 'gesture:flinch' },
  'boss-wound': { offIdle: 20, clip: 'HitRecieve' },
  'death-LIGHTNING': { offIdle: 40, clip: 'Death', drops: -0.4 },
  'death-DEADEYE': { offIdle: 40, clip: 'Death', drops: -0.4 },
  'death-QUICK': { offIdle: 40, clip: 'Death', drops: -0.4 },
  'death-STEADY': { offIdle: 40, clip: 'Death', drops: -0.4 },
  'death-LUCKY': { offIdle: 40, clip: 'Death', drops: -0.4 },
  'hat-falls': { offIdle: 40, clip: 'Death' },
  'loss-death': { offIdle: 40, clip: 'Death', drops: -0.4 },
  'victory-twirl-holster': { offIdle: 40, layer: 'draw:spin' },
  'victory-taunt': { offIdle: 40, layer: 'gesture:tipHat' },
  'rifleman-aim': { offIdle: 20, clip: 'Idle_Gun_Pointing', layer: 'long:aim' },
  'rifleman-fire': { offIdle: 20, layer: 'long:kick' },
  'rifleman-death': { offIdle: 40, clip: 'Death' },
}

interface StageRun {
  subject: number
  frames: number
  dt: number
}

export async function duelStage(ctx: BrowserContext, base: string): Promise<void> {
  const page = await ctx.newPage()
  await page.goto(`${base}/experiments/out-west/#lineup&kit&tier=high`)
  await page.waitForFunction(
    () => {
      const p = Reflect.get(globalThis, '__owAnim') as { stage: unknown } | undefined
      return Boolean(p?.stage)
    },
    undefined,
    { timeout: 180_000 },
  )
  await sleep(1500)
  const states = await page.evaluate(() =>
    (Reflect.get(globalThis, '__owAnim') as { stage: { states: () => string[] } }).stage.states(),
  )
  for (const state of states) {
    if (only && !state.includes(only)) {
      continue
    }
    const tp0 = await tposes(page)
    const run = await page.evaluate(
      (n) =>
        (
          Reflect.get(globalThis, '__owAnim') as { stage: { run: (s: string) => StageRun | null } }
        ).stage.run(n),
      state,
    )
    if (!run) {
      console.log(`skip duel/${state}: no subject (the rifle prop may be missing)`)
      continue
    }
    const dir = join(OUT, 'duel', state)
    await mkdir(dir, { recursive: true })
    const every = Math.max(1, Math.round(run.frames / 8))
    const ms: Measure[] = []
    const shots: Buffer[] = []
    await frameDone(page)
    for (let f = 0; f <= run.frames; f++) {
      if (f % every === 0 || f === run.frames) {
        await frameDone(page)
        const m = await page.evaluate(
          (i) =>
            (
              Reflect.get(globalThis, '__owAnim') as { measure: (i: number) => Measure | null }
            ).measure(i),
          run.subject,
        )
        if (m) {
          ms.push(m)
        }
        const png = await page.screenshot()
        await writeFile(join(dir, `f${String(f).padStart(3, '0')}.png`), png)
        shots.push(png)
      }
      await page.evaluate(() =>
        (Reflect.get(globalThis, '__owAnim') as { stage: { tick: () => number } }).stage.tick(),
      )
    }
    await sheet(dir, shots)
    const tp = (await tposes(page)) - tp0
    record({
      section: 'duel',
      state,
      ms,
      checks: judge(ms, DUEL_EXPECT[state] ?? { moves: 1 }, tp),
      dir,
    })
  }
  await page.close()
}

const LIVE: Record<string, (p: Measure[], e: Measure[]) => Record<string, boolean>> = {
  walk: (p, e) => ({
    playerWalks: p.some((m) => m.clips.some((k) => k.name === 'Walk' && k.w > 0.3)),
    enemyWalks: e.some((m) => m.clips.some((k) => k.name === 'Walk' && k.w > 0.3)),
    talkerGestures: e.some((m) => m.layers.some((l) => l.startsWith('gesture'))),
  }),
  wait: (p, e) => ({
    playerNerves: p.some((m) => m.layers.some((l) => l.startsWith('gesture'))),
    enemyNerves: e.some((m) => m.layers.some((l) => l.startsWith('gesture'))),
  }),
  call: (p) => ({ playerDraws: p.some((m) => m.layers.some((l) => l.startsWith('draw:draw'))) }),
  win: (p, e) => ({
    enemyDies: e.some((m) => m.clips.some((k) => k.name === 'Death')),
    playerTwirls: p.some((m) => m.layers.some((l) => l === 'draw:spin')),
    playerTaunts: p.some((m) => m.layers.some((l) => l === 'gesture:tipHat')),
  }),
}

interface Slot {
  p: Measure[]
  e: Measure[]
  folk: Measure[]
  shots: Buffer[]
}
const SAMPLED = ['walk', 'turn', 'wait', 'call', 'win', 'cock', 'poster']

/** Everyone drawn, split: you (behind the line), him (beyond it), the folk (off the centre line). */
async function samplePhase(page: Page, slot: Slot): Promise<void> {
  const world = (await all(page)).filter((m) => m.shown)
  const duel = world.filter((m) => Math.abs(m.pos[0]) < 0.6)
  slot.p.push(...duel.filter((m) => m.pos[2] < 0))
  slot.e.push(...duel.filter((m) => m.pos[2] >= 0))
  slot.folk.push(...world.filter((m) => Math.abs(m.pos[0]) >= 0.6))
  if (slot.shots.length < 8) {
    slot.shots.push(await page.screenshot())
  }
}

/** Play it: hold to walk, fire 200 ms after the call; sample each phase until 6 s after the end. */
async function play(
  page: Page,
  cdp: CDPSession,
): Promise<{ byPhase: Map<string, Slot>; tp0: number }> {
  const cx = 480
  const cy = 270
  const byPhase = new Map<string, Slot>()
  const st: { holding: boolean; fired: boolean; doneAt: number; tp0: number } = {
    holding: false,
    fired: false,
    doneAt: 0,
    tp0: -1,
  }
  const t0 = Date.now()
  while (Date.now() - t0 < 150_000 && !(st.doneAt && Date.now() - st.doneAt > 6000)) {
    const ph = await label(page)
    if (st.tp0 < 0 && ph === 'walk') {
      st.tp0 = await tposes(page)
    }
    if ((ph === 'walk') !== st.holding) {
      st.holding = ph === 'walk'
      await touch(cdp, st.holding ? 'touchStart' : 'touchEnd', cx, cy)
    }
    if (ph === 'call' && !st.fired) {
      await sleep(200)
      await page.mouse.click(cx, cy)
      st.fired = true
    }
    if (SAMPLED.includes(ph)) {
      const slot = byPhase.get(ph) ?? { p: [], e: [], folk: [], shots: [] }
      byPhase.set(ph, slot)
      await samplePhase(page, slot)
    }
    if (['win', 'lose', 'coward'].includes(ph) && !st.doneAt) {
      st.doneAt = Date.now()
    }
    await sleep(120)
  }
  return { byPhase, tp0: Math.max(0, st.tp0) }
}

export async function liveDuel(ctx: BrowserContext, base: string): Promise<void> {
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await page.setViewportSize({ width: 960, height: 540 })
  // level 2: the talker (his hands while he walks)
  await page.goto(`${base}/experiments/out-west/#level=2&perf&tier=high`)
  await page.locator('.ow-title.ready').waitFor({ timeout: 180_000 })
  await sleep(1500)
  await page.locator('.ow-start').click()
  const { byPhase, tp0 } = await play(page, cdp)
  const tp = (await tposes(page)) - tp0
  for (const [ph, slot] of byPhase) {
    const dir = join(OUT, 'live', ph)
    await mkdir(dir, { recursive: true })
    for (const [k, s] of slot.shots.entries()) {
      await writeFile(join(dir, `f${k}.png`), s)
    }
    await sheet(dir, slot.shots)
    const both = [...slot.p, ...slot.e]
    const checks = {
      posed: both.length > 0 && both.every((m) => m.poseWeight > 0.5 && m.bind > 3),
      tpose: tp === 0,
      ...(LIVE[ph]?.(slot.p, slot.e) ?? {}),
    }
    record({ section: 'live', state: ph, ms: both, checks, dir })
  }
  // the townsfolk through the whole duel
  const folk = [...byPhase.values()].flatMap((s) => s.folk)
  if (folk.length > 0) {
    record({
      section: 'live',
      state: 'townsfolk',
      ms: folk,
      checks: {
        posed: folk.every((m) => m.poseWeight > 0.5),
        tpose: tp === 0,
        moves: motionOf(folk.filter((m) => m.label === folk[0]?.label)) > 0.3,
        reacts: folk.some((m) =>
          m.clips.some((k) => k.name === 'Run' || k.name === 'Idle_Neutral'),
        ),
      },
      dir: join(OUT, 'live'),
    })
  }
  await page.close()
}
