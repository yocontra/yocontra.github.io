/** Mounted native encounter loading with actual actor/map requests held independently. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { ASSETS } from '../src/experiments/out-west/content/manifest.ts'
import type { NativeDirector } from '../src/experiments/out-west/duel/native-director.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-loading-proof'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const records: unknown[] = []
try {
  for (const held of ['map', 'actor', 'cancel'] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/@vite/client', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `export const createHotContext = () => ({ accept() {}, dispose() {}, on() {}, off() {}, send() {}, prune() {}, invalidate() {} });
export const injectQuery = value => value;
export const updateStyle = () => {};
export const removeStyle = () => {};`,
        }),
      )
      const target = held === 'map' ? ASSETS.bank : ASSETS['outlaw-14']
      const targetPath = new URL(target.url, origin).pathname
      await page.route(
        (url) => url.pathname === targetPath,
        async (route) => {
          await gate
          await route.continue()
        },
      )
      await page.goto(`${origin}/experiments/out-west/#debug&level=1`)
      await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
        timeout: 90_000,
      })
      await page.locator('.ow-start').click()
      await page.locator('.ow-title').waitFor({ state: 'detached' })
      const requested = page.waitForRequest(
        (request) => new URL(request.url()).pathname === targetPath,
        { timeout: 60_000 },
      )
      await page.evaluate(async () => {
        const d: NativeDirector = Reflect.get(globalThis, '__ow').director
        await d.startLevel(0)
        d.paused = false
        let watching = true
        const failures: string[] = []
        const insertions: { name: string; enabled: boolean }[] = []
        const addChild = d.game.stage.addChild.bind(d.game.stage)
        d.game.stage.addChild = (node) => {
          if (node.name === 'outlaw' || node.name === 'rifleman') {
            insertions.push({ name: node.name, enabled: node.enabled })
          }
          return addChild(node)
        }
        const sample = () => {
          if (!watching) {
            return
          }
          if (d.phase === 'loading' && !d.loadFailed && d.game.stage.enabled) {
            failures.push('Loading exposed the stage')
          }
          if (
            d.phase === 'title' &&
            d.game.stage.find((node) => node.name === 'outlaw' && node.enabled).length > 0
          ) {
            failures.push('Cancelled encounter exposed a late outlaw')
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
        Reflect.set(globalThis, '__loadingFrames', {
          failures,
          insertions,
          stop: () => {
            watching = false
          },
        })
        Reflect.set(globalThis, '__loadingPending', d.startLevel(14))
      })
      await requested
      await page.waitForFunction(
        (kind) => {
          const d: NativeDirector = Reflect.get(globalThis, '__ow').director
          return kind === 'map'
            ? d.game.stage.find((node) => node.name === 'outlaw' && !node.enabled).length > 0
            : d.arenas.id === 'bank'
        },
        held,
        { timeout: 60_000 },
      )
      const snapshot = () =>
        page.evaluate(() => {
          const d: NativeDirector = Reflect.get(globalThis, '__ow').director
          return {
            phase: d.phase,
            stage: d.game.stage.enabled,
            input: d.c.input.enabled,
            arena: d.arenas.id,
            enemy: Boolean(d.enemy?.root.enabled),
            pendingOutlaws: d.game.stage
              .find((node) => node.name === 'outlaw')
              .map((node) => ({ enabled: node.enabled })),
          }
        })
      const before = await snapshot()
      if (before.phase !== 'loading' || before.stage || before.input || before.enemy) {
        throw new Error(`Partial encounter exposed: ${JSON.stringify(before)}`)
      }
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().map((animation) => animation.finished))
      })
      await page.screenshot({ path: `${output}/${held}-loading.png` })
      if (held === 'cancel') {
        await page.evaluate(() =>
          (Reflect.get(globalThis, '__ow').director as NativeDirector).saloon(),
        )
      }
      release()
      await page.evaluate(async () => {
        await Reflect.get(globalThis, '__loadingPending')
      })
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
      })
      const after = await snapshot()
      if (
        !after.stage ||
        (held === 'cancel'
          ? after.phase !== 'title' || after.pendingOutlaws.length > 0
          : after.phase !== 'poster' || after.arena !== 'bank' || !after.enemy || !after.input)
      ) {
        throw new Error(`Encounter did not commit or cancel coherently: ${JSON.stringify(after)}`)
      }
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().map((animation) => animation.finished))
      })
      const frames = await page.evaluate(() => {
        const trace = Reflect.get(globalThis, '__loadingFrames')
        trace.stop()
        return {
          failures: trace.failures as string[],
          insertions: trace.insertions as { name: string; enabled: boolean }[],
        }
      })
      if (
        frames.failures.length > 0 ||
        frames.insertions.length === 0 ||
        frames.insertions.some((actor) => actor.enabled)
      ) {
        throw new Error(`Encounter frame/insertion failure: ${JSON.stringify(frames)}`)
      }
      await page.screenshot({
        path: `${output}/${held}-${held === 'cancel' ? 'saloon' : 'ready'}.png`,
      })
      records.push({ held, before, after, frames })
    } finally {
      release()
      await context.close()
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  await writeFile(`${output}/result.json`, `${JSON.stringify({ records, errors }, null, 2)}\n`)
  console.log(JSON.stringify({ cases: records.length, errors, output }))
} finally {
  await browser.close()
}
