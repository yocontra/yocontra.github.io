/** Complete mounted native scenes and seated/fleeing spectator placement regression. */
import { mkdir, writeFile } from 'node:fs/promises'
import type { Entity } from 'playcanvas'
import { chromium } from 'playwright'
import type {
  NativeDirector,
  NativePhase,
} from '../src/experiments/out-west/duel/native-director.ts'

const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-complete-scene-evidence-after'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
const records: unknown[] = []
try {
  await page.route('**/@vite/client', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `export const createHotContext = () => ({ accept() {}, dispose() {}, on() {}, off() {}, send() {}, prune() {}, invalidate() {} });
export const injectQuery = value => value;
export const updateStyle = () => {};
export const removeStyle = () => {};`,
    }),
  )
  await page.goto(
    `${process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'}/experiments/out-west/#debug&level=1`,
  )
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 90_000,
  })
  await page.locator('.ow-start').click()
  await page.locator('.ow-title').waitFor({ state: 'detached', timeout: 10_000 })
  await page.evaluate(async () => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    await d.startLevel(0)
    d.enter('cock')
    d.paused = true
    d.c.hud.hideCard()
    Reflect.set(globalThis, '__sceneView', { position: [2, 2.2, -7], target: [6, 1.6, 6] })
    d.game.app.on('prerender', () => {
      const v: { position: [number, number, number]; target: [number, number, number] } =
        Reflect.get(globalThis, '__sceneView')
      d.game.camera.setPosition(...v.position)
      d.game.camera.lookAt(...v.target)
    })
  })
  await page.addStyleTag({
    content:
      '.ow-hud,.ow-cap-call,.ow-cap-fake,.ow-cap-line,.ow-letter,.ow-card,.ow-walk-hint,.ow-input-hint,astro-dev-toolbar{visibility:hidden!important}',
  })
  async function capture(
    name: string,
    position: number[],
    target: number[],
    reaction: { phase?: NativePhase; cue?: string } = {},
  ) {
    const state = await page.evaluate(
      async ({ position: eye, target: look, phase: stage, cue: fake }) => {
        const d: NativeDirector = Reflect.get(globalThis, '__ow').director
        d.enter(stage)
        if (fake) {
          d.cue(fake)
        }
        Reflect.set(globalThis, '__sceneView', { position: eye, target: look })
        for (let n = 0; n < 8; n++) {
          await new Promise(requestAnimationFrame)
        }
        return {
          arena: d.arenas.id,
          phase: d.phase,
          life: d.atmosphere.stats,
          animations: d.game.stage
            .find((n) =>
              ['townsfolk-', 'town-horse-', 'town-crow-', 'town-hen-', 'fakeout-dog'].some(
                (prefix) => n.name.startsWith(prefix),
              ),
            )
            .filter((n) => n.enabled)
            .map((n) => ({
              name: n.name,
              position: n.getPosition().toArray(),
              clip: (n as Entity).findComponents('anim')[0]?.baseLayer?.activeState,
            })),
        }
      },
      { position, target, phase: reaction.phase ?? 'cock', cue: reaction.cue },
    )
    await page.screenshot({ path: `${output}/${name}.png` })
    records.push({ name, ...state })
    console.log(name, state.arena, state.life)
  }
  const anchored = await page.evaluate(() => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    const folk: {
      actor: { root: Entity; model: Entity }
      home: { habit?: string; y: number; floor?: number; door?: readonly number[] }
      hipsHeight: number
    }[] = Reflect.get(d.atmosphere, 'folk')
    return folk
      .filter((f) => f.home.habit === 'sit' || f.home.habit === 'whittle')
      .map((f) => ({
        habit: f.home.habit,
        rootY: f.actor.root.getPosition().y,
        expectedRootY: f.home.y - (f.hipsHeight - 0.1),
        hipsY: f.actor.model.findByName('Hips')?.getPosition().y,
        seatY: f.home.y,
        clip: f.actor.model.anim?.baseLayer?.activeState,
      }))
  })
  if (
    anchored.length !== 3 ||
    anchored.some((f) => Math.abs(f.rootY - f.expectedRootY) > 0.001 || f.clip !== 'Town_Sit')
  ) {
    throw new Error(`Spectator seat anchoring regressed: ${JSON.stringify(anchored)}`)
  }
  records.push({ anchored })
  await capture('street-horse-and-doorfolk', [2, 2.2, -4], [7, 1.6, 5])
  await capture('street-veranda-folk-horse', [-1, 2.3, 8], [-10, 2, 17])
  await capture('street-birds-and-hens', [-2, 1.6, 20], [-8.4, 1.3, 26])
  await capture('street-dog-and-leaning-folk', [3, 1.9, 17], [9.4, 1.2, 24])
  await capture('horse-fakeout', [2, 2.2, -4], [7, 1.6, 5], { cue: 'horse' })
  await capture('folk-call-reaction', [-1, 2.3, 8], [-10, 2, 17], { phase: 'call' })
  await capture('birds-flight-and-hens-scatter', [-2, 1.8, 20], [-7.8, 2.2, 26], { phase: 'win' })
  await capture('townsfolk-running-for-cover', [-1, 2.3, 8], [-10, 2, 17], { phase: 'win' })
  const fleeing = await page.evaluate(() => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    const folk: {
      actor: { root: Entity }
      home: { door?: readonly number[]; floor?: number }
      running: boolean
    }[] = Reflect.get(d.atmosphere, 'folk')
    return folk
      .filter((f) => f.home.door && f.running)
      .map((f) => ({ rootY: f.actor.root.getPosition().y, expectedFloor: f.home.floor ?? 0.34 }))
  })
  if (fleeing.length === 0 || fleeing.some((f) => Math.abs(f.rootY - f.expectedFloor) > 0.001)) {
    throw new Error(`Spectator flee floor regressed: ${JSON.stringify(fleeing)}`)
  }
  records.push({ fleeing })
  for (const [level, name] of [
    [6, 'depot-life'],
    [10, 'mission-life'],
    [13, 'bank-life'],
    [16, 'finale-clock-life'],
  ] as const) {
    await page.evaluate(async (levelIndex) => {
      const d: NativeDirector = Reflect.get(globalThis, '__ow').director
      await d.startLevel(levelIndex)
      d.paused = true
      d.enter('cock')
      d.c.hud.hideCard()
    }, level)
    const v = await page.evaluate(() => {
      const d: NativeDirector = Reflect.get(globalThis, '__ow').director
      const stand = d.arenas.life.horses[0] ?? d.arenas.life.folk[0]
      if (!stand) {
        throw new Error('Arena has no ambient inspection point')
      }
      return {
        position: [stand.x - 5, stand.y + 2.2, stand.z - 6],
        target: [stand.x, stand.y + 1.3, stand.z],
      }
    })
    await capture(name, v.position, v.target)
  }
  await page.evaluate(() => Reflect.get(globalThis, '__ow').destroy())
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      {
        scope:
          'Actual mounted NativeDirector and ambient components, paused local duel logic with inspection camera; native animation/reactions continue.',
        records,
        errors,
      },
      null,
      2,
    ),
  )
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
} finally {
  await browser.close()
}
