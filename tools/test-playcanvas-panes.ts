/** Actual native pane batching: a domain bullet crossing, reset, image parity and group lifetime. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-native-panes'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 812, height: 311 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await mkdir(output, { recursive: true })
  await page.route('**/__pane_probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
  )
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export const createHotContext = () => ({ accept() {}, dispose() {}, on() {}, off() {}, send() {}, prune() {}, invalidate() {} });
export const injectQuery = value => value;
export const updateStyle = () => {};
export const removeStyle = () => {};`,
    }),
  )
  await page.goto(`${origin}/__pane_probe`)
  await page.evaluate(async () => {
    const applicationPath = '/src/experiments/out-west/client/application.ts'
    const environmentPath = '/src/experiments/out-west/client/environment.ts'
    const windowsPath = '/src/experiments/out-west/client/windows.ts'
    const assetsPath = '/src/experiments/out-west/content/manifest.ts'
    const statePath = '/src/experiments/out-west/ffa/sim/state.ts'
    const combatPath = '/src/experiments/out-west/ffa/sim/windows.ts'
    const [
      { GameApplication },
      { NativeEnvironment },
      { BreakableWindows },
      { ASSETS },
      state,
      combat,
    ] = await Promise.all([
      import(applicationPath),
      import(environmentPath),
      import(windowsPath),
      import(assetsPath),
      import(statePath),
      import(combatPath),
    ])
    document.body.innerHTML =
      '<div id="view" style="position:fixed;inset:0"><canvas></canvas></div>'
    const canvas = document.querySelector('canvas')
    const viewport = document.querySelector<HTMLElement>('#view')
    if (!(canvas && viewport)) {
      throw new Error('Missing pane viewport')
    }
    const game = await GameApplication.create({ canvas, viewport })
    const town = await game.instantiate(ASSETS.frontier.url, 'town')
    const environment = new NativeEnvironment(game, true)
    environment.attach(town, await game.loadContainer(ASSETS.frontier.url))
    await environment.ready
    const windows = new BreakableWindows(town)
    const world = state.createWorld()
    const pane = world.grid.glass[0]
    const across = (pane.a0 + pane.a1) / 2
    const x = pane.axis === 0 ? pane.at : across
    const z = pane.axis === 0 ? across : pane.at
    const y = (pane.y0 + pane.y1) / 2
    game.camera.setPosition(x - (pane.axis === 0 ? 3 : 0), y, z - (pane.axis === 1 ? 3 : 0))
    game.camera.lookAt(x, y, z)
    const panes = town
      .findComponents('render')
      .filter((component: { entity: { name: string } }) =>
        component.entity.name.startsWith('glass-'),
      )
    const groups = new Set(
      panes.map((component: { batchGroupId: number }) => component.batchGroupId),
    )
    const batcher = game.app.batcher
    if (!batcher || groups.size !== 1 || groups.has(-1)) {
      throw new Error('Panes did not receive a separate native batch group')
    }
    const times: number[] = []
    const generate = batcher.generate
    batcher.generate = function (...args: Parameters<typeof generate>) {
      const start = performance.now()
      const result = generate.apply(this, args)
      times.push(performance.now() - start)
      return result
    }
    Reflect.set(globalThis, '__paneProbe', {
      game,
      town,
      environment,
      windows,
      world,
      combat,
      panes,
      groups,
      times,
    })
  })
  const sample = () =>
    page.evaluate(async () => {
      const { game, world, windows, panes, groups } = Reflect.get(globalThis, '__paneProbe')
      windows.update(world.glass)
      await new Promise<void>((resolve) => game.app.once('postrender', resolve))
      const batches = game.app.batcher.getBatches([...groups][0])
      return {
        intact: windows.stats().intact,
        batches: batches.length,
        members: batches.reduce(
          (sum: number, batch: { origMeshInstances: object[] }) =>
            sum + batch.origMeshInstances.length,
          0,
        ),
        shadows: batches.filter(
          (batch: { meshInstance: { castShadow: boolean } }) => batch.meshInstance.castShadow,
        ).length,
        originals: panes.length,
        draws: game.app.stats.drawCalls.total,
      }
    })
  const intact = await sample()
  await page.screenshot({ path: `${output}/intact.png` })
  const crossed = await page.evaluate(() => {
    const { world, combat } = Reflect.get(globalThis, '__paneProbe')
    const pane = world.grid.glass[0]
    const across = (pane.a0 + pane.a1) / 2
    const x = pane.axis === 0 ? pane.at : across
    const z = pane.axis === 0 ? across : pane.at
    const y = (pane.y0 + pane.y1) / 2
    combat.shatterGlass(
      world,
      x - (pane.axis === 0 ? 1 : 0),
      y,
      z - (pane.axis === 1 ? 1 : 0),
      pane.axis === 0 ? 1 : 0,
      0,
      pane.axis === 1 ? 1 : 0,
      2,
    )
    return world.events.filter((event: { type: string }) => event.type === 'glass_break').length
  })
  const broken = await sample()
  await page.screenshot({ path: `${output}/broken.png` })
  await page.evaluate(() => Reflect.get(globalThis, '__paneProbe').world.glass.fill(0))
  const restored = await sample()
  await page.screenshot({ path: `${output}/restored.png` })
  const lifecycle = await page.evaluate(() => {
    const { game, town, environment, groups, times } = Reflect.get(globalThis, '__paneProbe')
    town.destroy()
    const remaining = [...groups].flatMap((id) => game.app.batcher.getBatches(id)).length
    environment.destroy()
    game.destroy()
    return { remaining, rebuildMs: times }
  })
  if (
    !(
      crossed > 0 &&
      broken.intact === intact.intact - crossed &&
      broken.members === intact.members - crossed &&
      restored.members === intact.members &&
      restored.intact === intact.intact &&
      intact.batches < intact.originals / 10 &&
      [intact, broken, restored].every((state) => state.shadows === 0) &&
      lifecycle.remaining === 0 &&
      errors.length === 0
    )
  ) {
    throw new Error(
      `Native pane regression: ${JSON.stringify({ intact, crossed, broken, restored, lifecycle, errors })}`,
    )
  }
  const result = { intact, crossed, broken, restored, lifecycle, errors }
  await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
