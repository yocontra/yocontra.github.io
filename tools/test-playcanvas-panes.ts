/** Actual native shot removes the original textured pane; adjacent panes, reset and batches survive. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import sharp from 'sharp'

async function imageDifference(first: string, second: string) {
  const [a, b] = await Promise.all(
    [first, second].map((path) => sharp(path).ensureAlpha().raw().toBuffer()),
  )
  if (!(a && b) || a.length !== b.length) {
    throw new Error('Pane snapshots changed size')
  }
  let changed = 0
  let total = 0
  let maximum = 0
  for (let index = 0; index < a.length; index++) {
    const difference = Math.abs((a[index] ?? 0) - (b[index] ?? 0))
    changed += Number(difference > 0)
    total += difference
    maximum = Math.max(maximum, difference)
  }
  return { changed, mean: total / a.length, maximum }
}

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
    const simulationPath = '/src/experiments/out-west/runtime/frontier.ts'
    const ammoPath = '/src/experiments/out-west/runtime/ammo.ts'
    const collisionPath = '/src/experiments/out-west/content/collision.json'
    const worldPath = '/src/experiments/out-west/ffa/sim/world.ts'
    const protocolPath = '/src/experiments/out-west/runtime/protocol.ts'
    const contractPath = '/src/experiments/out-west/contract/town.ts'
    const [
      { GameApplication },
      { NativeEnvironment },
      { BreakableWindows },
      { ASSETS },
      { createFrontierSimulation },
      { loadAmmo },
      { default: collision },
      { addPlayer },
      { Buttons },
      { ANGLE_SCALE },
    ] = await Promise.all([
      import(applicationPath),
      import(environmentPath),
      import(windowsPath),
      import(assetsPath),
      import(simulationPath),
      import(ammoPath),
      import(collisionPath),
      import(worldPath),
      import(protocolPath),
      import(contractPath),
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
    const simulation = createFrontierSimulation({ ammo: await loadAmmo(), collision, seed: 7 })
    const world = simulation.world
    const shooter = addPlayer(world, {
      accountId: 'native-pane-fixture',
      name: 'Rider',
      level: 1,
      prestige: 0,
      bot: false,
    })
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
    const glazing = town
      .findComponents('render')
      .filter((component: { meshInstances: { material: { name: string } }[] }) =>
        component.meshInstances.some((instance) =>
          ['window-glass', 'breakable-glass'].includes(instance.material.name),
        ),
      )
    if (
      glazing.length !== 296 ||
      panes.length !== 296 ||
      town.find((node: { name: string }) => node.name.startsWith('window-glass-')).length > 0
    ) {
      throw new Error('Original and synthetic glazing still overlap')
    }
    if (
      !panes.every(
        (component: {
          meshInstances: { material: { name: string; diffuseMap: object | null } }[]
        }) =>
          component.meshInstances.every(
            (instance) => instance.material.name === 'window-glass' && instance.material.diffuseMap,
          ),
      )
    ) {
      throw new Error('Breakable planes did not preserve the original native PBR texture')
    }
    game.app.timeScale = 0
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
      simulation,
      shooter,
      Buttons,
      ANGLE_SCALE,
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
        firstEnabled: panes[0].entity.enabled,
        adjacentEnabled: panes[1].entity.enabled,
        draws: game.app.stats.drawCalls.total,
      }
    })
  const intact = await sample()
  await page.screenshot({ path: `${output}/intact.png` })
  const crossed = await page.evaluate(() => {
    const { world, simulation, shooter, Buttons, ANGLE_SCALE } = Reflect.get(
      globalThis,
      '__paneProbe',
    )
    const pane = world.grid.glass[0]
    const across = (pane.a0 + pane.a1) / 2
    const x = pane.axis === 0 ? pane.at : across
    const z = pane.axis === 0 ? across : pane.at
    const y = (pane.y0 + pane.y1) / 2
    const player = world.players[shooter]
    player.x = x - (pane.axis === 0 ? 1 : 0)
    player.y = y - 1.62
    player.z = z - (pane.axis === 1 ? 1 : 0)
    for (let tick = 0; tick < 20; tick++) {
      simulation.step([
        {
          seq: tick,
          moveX: 0,
          moveZ: 0,
          aim: pane.axis === 0 ? 0 : ANGLE_SCALE / 4,
          pitch: 0,
          buttons: Buttons.fire,
          viewTime: world.tick,
        },
      ])
      if (world.events.some((event: { type: string }) => event.type === 'shot')) {
        break
      }
    }
    if (player.stats.shots !== 1 || world.glass[pane.index] !== 1) {
      throw new Error('Native authoritative shot failed to shatter the textured pane')
    }
    return world.events.filter((event: { type: string }) => event.type === 'glass_break').length
  })
  const broken = await sample()
  await page.screenshot({ path: `${output}/broken.png` })
  await page.evaluate(() => Reflect.get(globalThis, '__paneProbe').world.glass.fill(0))
  const restored = await sample()
  await page.screenshot({ path: `${output}/restored.png` })
  const lifecycle = await page.evaluate(() => {
    const { game, town, environment, simulation, groups, times } = Reflect.get(
      globalThis,
      '__paneProbe',
    )
    town.destroy()
    const remaining = [...groups].flatMap((id) => game.app.batcher.getBatches(id)).length
    environment.destroy()
    simulation.dispose()
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
      intact.firstEnabled &&
      !broken.firstEnabled &&
      restored.firstEnabled &&
      intact.adjacentEnabled &&
      broken.adjacentEnabled &&
      restored.adjacentEnabled &&
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
  const image = {
    broken: await imageDifference(`${output}/intact.png`, `${output}/broken.png`),
    restored: await imageDifference(`${output}/intact.png`, `${output}/restored.png`),
  }
  // A broken pane changes the image; reset may differ by native batch rounding, never a visible pane.
  if (image.broken.mean < 0.1 || image.restored.mean > 0.02) {
    throw new Error(`Pane break/reset image regression: ${JSON.stringify(image)}`)
  }
  const result = { intact, crossed, broken, restored, lifecycle, image, errors }
  await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
