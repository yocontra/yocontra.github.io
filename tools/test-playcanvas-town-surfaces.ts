/** Matched native town views; an optional staged container never replaces published assets. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { GameApplication as Application } from '../src/experiments/out-west/client/application.ts'
import type { NativeEnvironment as Environment } from '../src/experiments/out-west/client/environment.ts'
import { FRONTIER_VIEWS } from '../src/experiments/out-west/ffa/town.views.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4389'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-town-surfaces'
const candidate = process.env.OW_TOWN_CONTAINER
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
interface Probe {
  game: Application
  environment: Environment
}
try {
  await mkdir(output, { recursive: true })
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await page.route('**/__town_surface_probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
  )
  if (candidate) {
    await page.route('**/frontier-detail.glb?*', (route) =>
      route.fulfill({ contentType: 'model/gltf-binary', path: candidate }),
    )
  }
  await page.goto(`${origin}/__town_surface_probe`)
  await page.evaluate(async () => {
    const applicationPath = '/src/experiments/out-west/client/application.ts'
    const environmentPath = '/src/experiments/out-west/client/environment.ts'
    const manifestPath = '/src/experiments/out-west/content/manifest.ts'
    const [{ GameApplication }, { NativeEnvironment }, { ASSETS }] = await Promise.all([
      import(applicationPath),
      import(environmentPath),
      import(manifestPath),
    ])
    document.body.innerHTML =
      '<div id="view" style="position:fixed;inset:0"><canvas id="canvas"></canvas></div>'
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas')
    const viewport = document.querySelector<HTMLElement>('#view')
    if (!(canvas && viewport)) {
      throw new Error('Missing native viewport')
    }
    const game = await GameApplication.create({ canvas, viewport })
    const town = await game.instantiate(ASSETS.frontier.url, 'town')
    const environment = new NativeEnvironment(game, true)
    environment.attach(town, await game.loadContainer(ASSETS.frontier.url))
    await environment.ready
    Reflect.set(globalThis, '__townSurfaceProbe', { game, environment })
  })
  const selected = new Set(['facade-saloon', 'facade-store', 'saloon-back', 'saloon-bar'])
  for (const day of [0.3, 0.65, 0.9]) {
    for (const view of FRONTIER_VIEWS.filter((entry) => selected.has(entry.name))) {
      await page.evaluate(
        async ({ view: cameraView, day: time }) => {
          const { game, environment } = Reflect.get(globalThis, '__townSurfaceProbe') as Probe
          await environment.setTime(time)
          game.camera.setPosition(...cameraView.from)
          game.camera.lookAt(...cameraView.to)
          if (game.camera.camera) {
            game.camera.camera.fov = cameraView.fov ?? 60
          }
          for (let frame = 0; frame < 8; frame++) {
            await new Promise<void>((resolve) => game.app.once('postrender', resolve))
          }
        },
        { view, day },
      )
      await page.screenshot({ path: `${output}/${view.name}-${day}.png` })
    }
  }
  await writeFile(`${output}/receipt.json`, JSON.stringify({ candidate, errors }, null, 2))
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
} finally {
  await browser.close()
}
