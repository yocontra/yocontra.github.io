// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: states and frames run one after another on purpose
/** The animation audit's Frontier section: the local rider, the remote riders, the view model. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import type { BrowserContext, CDPSession, Page } from 'playwright'
import {
  all,
  type Expect,
  judge,
  type Measure,
  OUT,
  only,
  record,
  sheet,
  sleep,
  tposes,
} from './lib.ts'

/** Frontier's own view hooks (harness builds): `set`, `ads`, `closeHowTo`, `weapon`. */
const view = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const v = Reflect.get(globalThis, '__frontierView') as
        | Record<string, (...x: unknown[]) => unknown>
        | undefined
      return v?.[f as string]?.(...(a as unknown[]))
    },
    [fn, args] as const,
  )

const debugOf = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(() => {
    const f = Reflect.get(globalThis, '__frontier') as (() => Record<string, unknown>) | undefined
    return f ? f() : {}
  })

interface FrontierState {
  name: string
  view: 'third' | 'first'
  keys?: string[]
  ads?: boolean
  /** A touch button (by class) held through the state. */
  hold?: string
  /** Tapped once at the start. */
  tap?: string
  ms: number
  /** Expectations on the LOCAL rider (or the view model in first person). */
  expect: Expect
}

const FRONTIER: FrontierState[] = [
  { name: 'idle', view: 'third', ms: 1500, expect: { moves: 0.3 } },
  {
    name: 'ads-from-holster',
    view: 'third',
    ads: true,
    ms: 1500,
    expect: { clip: 'Idle_Gun_Pointing|LocoArm', offIdle: 30 },
  },
  { name: 'walk', view: 'third', keys: ['KeyW'], ms: 1800, expect: { moves: 15, clip: 'Walk' } },
  { name: 'strafe', view: 'third', keys: ['KeyD'], ms: 1800, expect: { moves: 15 } },
  { name: 'backpedal', view: 'third', keys: ['KeyS'], ms: 1800, expect: { moves: 15 } },
  {
    name: 'sprint',
    view: 'third',
    keys: ['KeyW', 'ShiftLeft'],
    ms: 1800,
    expect: { moves: 15, clip: 'Sprint' },
  },
  {
    name: 'crouch-idle',
    view: 'third',
    tap: '.fr-btn-crouch',
    ms: 1500,
    expect: { clip: 'Crouch_Idle', drops: -0.15 },
  },
  {
    name: 'crouch-walk',
    view: 'third',
    keys: ['KeyW'],
    ms: 1800,
    expect: { clip: 'Crouch_Walk', moves: 10 },
  },
  {
    name: 'stand-up',
    view: 'third',
    tap: '.fr-btn-crouch',
    ms: 800,
    expect: { moves: 0.3 },
  },
  {
    name: 'slide',
    view: 'third',
    keys: ['KeyW', 'ShiftLeft'],
    tap: '.fr-btn-crouch',
    ms: 1200,
    expect: { clip: 'Crouch_Idle', drops: -0.15 },
  },
  { name: 'jump', view: 'third', tap: '.fr-btn-jump', ms: 1100, expect: { clip: 'Jump_Loop' } },
  {
    name: 'hip-fire',
    view: 'third',
    hold: '.fr-btn-fire',
    ms: 1500,
    expect: { clip: 'Idle_Gun_Pointing|LocoArm', offIdle: 30 },
  },
  {
    name: 'ads-hold',
    view: 'third',
    ads: true,
    ms: 1500,
    expect: { clip: 'Idle_Gun_Pointing|LocoArm', offIdle: 30 },
  },
  {
    name: 'ads-fire',
    view: 'third',
    ads: true,
    hold: '.fr-btn-fire',
    ms: 1500,
    expect: { clip: 'Idle_Gun_Pointing|LocoArm', offIdle: 30 },
  },
  {
    name: 'reload',
    view: 'third',
    tap: '.fr-btn-reload',
    ms: 1800,
    expect: { clip: 'LocoReload|Reload' },
  },
  { name: 'fp-idle', view: 'first', ms: 1500, expect: { moves: 0.3 } },
  { name: 'fp-fire', view: 'first', hold: '.fr-btn-fire', ms: 1500, expect: { moves: 0.3 } },
  { name: 'fp-reload', view: 'first', tap: '.fr-btn-reload', ms: 2200, expect: { moves: 1 } },
  { name: 'fp-ads', view: 'first', ads: true, ms: 1500, expect: { moves: 0.3 } },
  { name: 'fp-sprint', view: 'first', keys: ['KeyW', 'ShiftLeft'], ms: 1500, expect: { moves: 1 } },
]

async function holdButton(page: Page, cdp: CDPSession, cls: string, on: boolean): Promise<void> {
  const box = await page.locator(cls).first().boundingBox()
  if (!box) {
    return
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await cdp.send('Input.dispatchTouchEvent', {
    type: on ? 'touchStart' : 'touchEnd',
    touchPoints: on ? [{ x, y, id: 7 }] : [],
  })
}

/** Into the town: alive, the how-to closed. */
async function arrive(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/experiments/out-west/frontier/?bots=12&seed=7&name=Audit#tier=high`)
  await page.waitForFunction(
    () => typeof Reflect.get(globalThis, '__frontier') === 'function',
    undefined,
    { timeout: 180_000 },
  )
  await page.waitForFunction(
    () => {
      const f = Reflect.get(globalThis, '__frontier') as () => { alive?: boolean }
      return f().alive === true
    },
    undefined,
    { timeout: 120_000 },
  )
  await view(page, 'closeHowTo')
  await sleep(1500)
}

/** Start a state's input: the view, the sights, held keys, a tap, a held touch button. */
async function begin(page: Page, cdp: CDPSession, st: FrontierState): Promise<void> {
  await view(page, 'closeHowTo')
  const skipBtn = page.getByRole('button', { name: 'Skip' })
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click().catch(() => undefined)
  }
  await view(page, 'set', st.view)
  await view(page, 'ads', st.ads ?? false)
  await sleep(500)
  for (const k of st.keys ?? []) {
    await page.keyboard.down(k)
  }
  if (st.keys && st.tap) {
    // up to speed first (a slide is a crouch tap mid-sprint)
    await sleep(700)
  }
  if (st.tap?.startsWith('.')) {
    await holdButton(page, cdp, st.tap, true)
    await sleep(160)
    await holdButton(page, cdp, st.tap, false)
  } else if (st.tap) {
    await page.keyboard.down(st.tap)
    await sleep(160)
    await page.keyboard.up(st.tap)
  }
  if (st.hold) {
    await holdButton(page, cdp, st.hold, true)
  }
}

async function end(page: Page, cdp: CDPSession, st: FrontierState): Promise<void> {
  for (const k of st.keys ?? []) {
    await page.keyboard.up(k)
  }
  if (st.hold) {
    await holdButton(page, cdp, st.hold, false)
  }
}

/**
 * One sample: the local rider (in third person the man nearest your position; in first person
 * the one actor in the lens's own scene, the view model) and the remote riders near you.
 */
async function sampleOnce(
  page: Page,
  first: boolean,
): Promise<{ local: Measure | undefined; remotes: Measure[] }> {
  const d = await debugOf(page)
  const shown = (await all(page)).filter((m) => m.shown)
  const scenes = new Map<string, number>()
  for (const m of shown) {
    scenes.set(m.scene, (scenes.get(m.scene) ?? 0) + 1)
  }
  const worldScene = [...scenes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const x = Number(d.x ?? 0)
  const z = Number(d.z ?? 0)
  const world = shown.filter((m) => m.scene === worldScene)
  const near = (m: Measure) => Math.hypot(m.pos[0] - x, m.pos[2] - z)
  const local = first
    ? shown.find((m) => m.scene !== worldScene)
    : [...world].sort((a, b) => near(a) - near(b))[0]
  return { local, remotes: world.filter((m) => m !== local && near(m) > 2) }
}

export async function frontier(ctx: BrowserContext, base: string): Promise<void> {
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await page.setViewportSize({ width: 960, height: 540 })
  await arrive(page, base)
  const tp0 = await tposes(page)
  const remoteSeen: Measure[] = []
  for (const st of FRONTIER) {
    if (only && !st.name.includes(only)) {
      continue
    }
    await begin(page, cdp, st)
    const dir = join(OUT, 'frontier', st.name)
    await mkdir(dir, { recursive: true })
    const ms: Measure[] = []
    const shots: Buffer[] = []
    const t0 = Date.now()
    while (Date.now() - t0 < st.ms || ms.length < 5) {
      const { local, remotes } = await sampleOnce(page, st.view === 'first')
      if (local) {
        ms.push(local)
      }
      remoteSeen.push(...remotes)
      if (shots.length < 8) {
        shots.push(await page.screenshot())
      }
      await sleep(60)
    }
    await end(page, cdp, st)
    for (const [k, s] of shots.entries()) {
      await writeFile(join(dir, `f${k}.png`), s)
    }
    await sheet(dir, shots)
    const tp = (await tposes(page)) - tp0
    record({ section: 'frontier', state: st.name, ms, checks: judge(ms, st.expect, tp), dir })
    await sleep(400)
  }
  // the remote riders: which clips and layers the near ones ever showed
  if (remoteSeen.length > 0) {
    const clips = new Set(
      remoteSeen.flatMap((m) => m.clips.filter((k) => k.w > 0.2).map((k) => k.name)),
    )
    console.log(`frontier remote riders (near, skinned): clips seen ${[...clips].join(', ')}`)
    record({
      section: 'frontier',
      state: 'remote-riders',
      ms: remoteSeen,
      checks: {
        posed: remoteSeen.every((m) => m.poseWeight > 0.5 && m.bind > 3),
        runs: clips.has('Run') || clips.has('Walk'),
        aims: clips.has('Idle_Gun_Pointing') || clips.has('LocoArm'),
      },
      dir: join(OUT, 'frontier'),
    })
  }
  await page.close()
}
