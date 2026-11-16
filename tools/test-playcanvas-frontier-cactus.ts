/** First actual-main near-cactus checkpoint: headless, immutable routes, no provider/microphone. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RenderComponent, StandardMaterial } from 'playcanvas'
import type { Page } from 'playwright'
import { chromium } from 'playwright'
import type { GameApplication } from '../src/experiments/out-west/client/application.ts'
import type { NativeEnvironment } from '../src/experiments/out-west/client/environment.ts'
import {
  CACTUS_MATERIAL,
  cactusHash,
  cactusStage,
  freezeCactusFiles,
  verifyCactusFiles,
  verifyCactusJob,
} from './content/frontier-cactus-candidate.ts'

interface Mounted {
  game: GameApplication
  environment: NativeEnvironment
}
const alignment =
  'ASSERT FAILED:  Non-interleaved vertex format with element size not multiple of 4 can have performance impact on some platforms. Element size: '
const isAlignment = (text: string) => text === `${alignment}3` || text === `${alignment}6`
export async function frozenCactus(stage: string) {
  const job = await verifyCactusJob(stage)
  const receiptBytes = await readFile(join(stage, 'candidate-receipt.json'))
  const receipt = JSON.parse(receiptBytes.toString()) as {
    authoringReceiptSHA256: string
    files: { path: string; sha256: string }[]
    output: { path: string; sha256: string }
  }
  if (resolve(receipt.output.path) !== join(stage, 'frontier-cactus.glb')) {
    throw new Error('Unexpected cactus output path')
  }
  await verifyCactusFiles([...receipt.files, receipt.output])
  if (
    cactusHash(await readFile(join(stage, 'authoring-receipt.json'))) !==
    receipt.authoringReceiptSHA256
  ) {
    throw new Error('Changed cactus generation chain')
  }
  const bytes = await freezeCactusFiles([
    ...job.inputs,
    ...job.scripts,
    ...receipt.files,
    receipt.output,
  ])
  const baseline = bytes.get(job.environment)
  const candidate = bytes.get(receipt.output.path)
  if (!(baseline && candidate)) {
    throw new Error('Missing immutable cactus route bytes')
  }
  return { job, baseline, candidate, receiptSHA256: cactusHash(receiptBytes) }
}
/** Serialized by Playwright; imports and all values used here are browser-local. */
export async function mountScene({ tier }: { tier: 'low' | 'high' }) {
  const appPath = '/src/experiments/out-west/client/application.ts'
  const environmentPath = '/src/experiments/out-west/client/environment.ts'
  const [{ GameApplication: Application }, { NativeEnvironment: Environment }] = await Promise.all([
    import(appPath),
    import(environmentPath),
  ])
  document.body.innerHTML =
    '<div id="view" style="position:fixed;inset:0"><canvas id="canvas"></canvas></div>'
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')
  const viewport = document.querySelector<HTMLElement>('#view')
  if (!(canvas && viewport)) {
    throw new Error('Missing cactus viewport')
  }
  const game = (await Application.create({
    canvas,
    viewport,
    tier,
    pixelRatio: 1,
  })) as GameApplication
  const environment = new Environment(game, true) as NativeEnvironment
  Reflect.set(globalThis, '__cactus', { game, environment })
  const load = Reflect.get(game, 'loadAsset')
  if (typeof load !== 'function' || !load.toString().includes('enableGGXSpecular')) {
    throw new Error('Actual native application lacks reviewed GGX hook')
  }
  game.app.timeScale = 0
  const url = '/__cactus/environment.glb'
  const town = await game.instantiate(url, 'Cactus main comparison')
  const container = await game.loadContainer(url)
  environment.attach(town, container)
  await environment.ready
  await environment.setTime(0.3)
  game.app.soundManager.volume = 0
  const adaptive = Reflect.get(game, 'update')
  if (typeof adaptive !== 'function') {
    throw new Error('Missing native adaptive update')
  }
  game.app.off('update', adaptive)
  game.app.graphicsDevice.maxPixelRatio = 1
  game.app.resizeCanvas(1280, 800)
  const inspect = (m: StandardMaterial) => ({
    name: m.name,
    ggx: m.enableGGXSpecular,
    lighting: m.useLighting,
    diffuse: [m.diffuse.r, m.diffuse.g, m.diffuse.b],
    metalness: m.metalness,
    maps: [m.diffuseMap, m.normalMap, m.glossMap, m.aoMap].map((t) =>
      t ? { name: t.name, width: t.width, height: t.height } : null,
    ),
    uv: [m.diffuseMapUv, m.normalMapUv, m.glossMapUv, m.aoMapUv],
  })
  const resource = container.resource as { materials: { resource: StandardMaterial }[] }
  const sources = resource.materials.map((asset) => inspect(asset.resource))
  const clones = [
    ...new Set(
      (town.findComponents('render') as RenderComponent[]).flatMap((c) =>
        c.meshInstances.map((i) => i.material as StandardMaterial),
      ),
    ),
  ].map(inspect)
  if ([...sources, ...clones].some((m) => m.lighting && !m.ggx)) {
    throw new Error('Native lit material is not GGX')
  }
  return { loadSource: load.toString(), sources, clones, tier: game.tier }
}
export async function captureViews(
  page: Page,
  {
    output,
    center,
    tier,
    variant,
    records,
  }: {
    output: string
    center: number[]
    tier: string
    variant: string
    records: unknown[]
  },
) {
  const views = [
    { name: 'body-1m', delta: [0.75, 0.2, -0.75], aim: [0, 0, 0] },
    { name: 'body-3m', delta: [2.1, 0.5, -2.1], aim: [0, 0, 0] },
    { name: 'crown', delta: [0.55, 1.1, -0.55], aim: [0, 0.55, 0] },
    { name: 'arm-junction', delta: [-0.75, 0.2, -0.75], aim: [0, 0, 0] },
  ]
  for (const view of views) {
    const frame = await page.evaluate(
      async ({ position, cameraView }) => {
        const { game } = Reflect.get(globalThis, '__cactus') as Mounted
        game.camera.setPosition(
          ...(position.map((v, i) => v + (cameraView.delta[i] ?? 0)) as [number, number, number]),
        )
        game.camera.lookAt(
          ...(position.map((v, i) => v + (cameraView.aim[i] ?? 0)) as [number, number, number]),
        )
        const camera = game.camera.camera
        if (!camera) {
          throw new Error('Missing native cactus camera')
        }
        camera.fov = 50
        for (let i = 0; i < 12; i++) {
          await new Promise<void>((done) => game.app.once('postrender', done))
        }
        const device = game.app.graphicsDevice
        return {
          textures: device.textures.size,
          buffers: device.buffers.size,
          draws: game.app.stats.drawCalls.total,
          camera: game.camera.getPosition().toString(),
          target: position.map((v, i) => v + (cameraView.aim[i] ?? 0)),
        }
      },
      { position: center, cameraView: view },
    )
    const image = `${tier}-${variant}-${view.name}.png`
    await page.screenshot({ path: join(output, image) })
    records.push({ tier, variant, view: view.name, image, frame })
    await writeFile(join(output, 'frames-partial.json'), `${JSON.stringify(records, null, 2)}\n`)
  }
}
export function disposeScene(page: Page) {
  return page.evaluate(() => {
    const mounted = Reflect.get(globalThis, '__cactus') as Mounted | undefined
    if (!mounted) {
      return null
    }
    const device = mounted.game.app.graphicsDevice
    mounted.environment.destroy()
    mounted.game.destroy()
    return { textures: device.textures.size, buffers: device.buffers.size }
  })
}
async function proof(stageInput: string, outputInput: string, origin: string): Promise<void> {
  const stage = await cactusStage(stageInput)
  const output = await cactusStage(outputInput)
  const frozen = await frozenCactus(stage)
  const records: unknown[] = []
  const lifecycle: unknown[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const diagnostics: unknown[] = []
  const diagnosticStacks: unknown[] = []
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  let failure: string | undefined
  try {
    for (const tier of ['low', 'high'] as const) {
      for (const variant of ['baseline', 'candidate'] as const) {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
        })
        const page = await context.newPage()
        const protocol = await context.newCDPSession(page)
        await protocol.send('Runtime.enable')
        protocol.on('Runtime.consoleAPICalled', (event) => {
          const text = event.args.map((a) => String(a.value)).join(' ')
          if (isAlignment(text)) {
            diagnosticStacks.push({ tier, variant, text, stack: event.stackTrace })
          }
        })
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('console', (message) => {
          if (message.type() === 'warning') {
            warnings.push(message.text())
          }
          if (message.type() !== 'error') {
            return
          }
          if (isAlignment(message.text())) {
            diagnostics.push({ tier, variant, text: message.text(), location: message.location() })
          } else {
            errors.push(message.text())
          }
        })
        await page.routeWebSocket('**/*', (socket) => socket.close())
        await page.route('**/*', (route) => {
          const url = new URL(route.request().url())
          if (url.origin !== origin) {
            errors.push(`Unexpected external request: ${url.origin}${url.pathname}`)
            return route.abort()
          }
          if (url.pathname === '/@vite/client') {
            return route.fulfill({
              contentType: 'application/javascript',
              body: `export const createHotContext=()=>({accept(){},dispose(){},on(){},off(){},send(){},prune(){},invalidate(){}});
export const injectQuery=value=>value; export const updateStyle=()=>{}; export const removeStyle=()=>{};`,
            })
          }
          if (url.pathname === '/__cactus/probe') {
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' })
          }
          if (url.pathname === '/__cactus/environment.glb') {
            return route.fulfill({ contentType: 'model/gltf-binary', body: frozen[variant] })
          }
          if (url.pathname.startsWith('/__cactus/')) {
            return route.fulfill({ status: 404, body: 'Unknown cactus review asset' })
          }
          return route.continue()
        })
        try {
          await page.goto(`${origin}/__cactus/probe`)
          const execution = await page.evaluate(mountScene, { tier })
          if (variant === 'candidate') {
            const materials = [...execution.sources, ...execution.clones].filter((m) =>
              m.name.startsWith(CACTUS_MATERIAL),
            )
            if (
              materials.length < 2 ||
              materials.some((m) => m.maps.some((map) => !map) || m.uv.some((uv) => uv !== 0))
            ) {
              throw new Error('Candidate source/clone maps or UV0 missing')
            }
          }
          await writeFile(
            join(output, `${tier}-${variant}-execution.json`),
            `${JSON.stringify(execution, null, 2)}\n`,
          )
          await captureViews(page, {
            output,
            center: frozen.job.target.center,
            tier,
            variant,
            records,
          })
        } finally {
          try {
            const final = await disposeScene(page).catch((error: unknown) => {
              errors.push(String(error))
              return null
            })
            lifecycle.push({ tier, variant, final })
            if (final && (final.textures !== 0 || final.buffers !== 0)) {
              errors.push(`Cactus teardown failed: ${JSON.stringify(final)}`)
            }
          } finally {
            await context.close()
          }
        }
      }
    }
    if ((await frozenCactus(stage)).receiptSHA256 !== frozen.receiptSHA256) {
      throw new Error('Candidate receipt changed during proof')
    }
    if (errors.length > 0) {
      throw new Error(errors.join('\n'))
    }
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error)
    throw error
  } finally {
    await writeFile(
      join(output, 'receipt.json'),
      `${JSON.stringify(
        {
          status: failure
            ? 'FAIL; retained evidence'
            : 'native checkpoint only; root art review required',
          candidateReceiptSHA256: frozen.receiptSHA256,
          probeSHA256: cactusHash(await readFile(import.meta.path)),
          baselineSHA256: cactusHash(frozen.baseline),
          candidateSHA256: cactusHash(frozen.candidate),
          records,
          lifecycle,
          errors,
          warnings,
          diagnostics,
          diagnosticStacks,
          failure,
          limits:
            'Actual main yard only. Camera obstruction/art requires review. Exact known packed-stream diagnostics retained with raw stacks; performance gate open. No all84/all44, FPS, photoreal or provider claim.',
        },
        null,
        2,
      )}\n`,
    )
    await browser.close()
  }
}
if (import.meta.main) {
  const [stage, output] = process.argv.slice(2)
  const origin = process.env.OW_ORIGIN
  if (!(stage && output && origin)) {
    throw new Error('Use STAGE EVIDENCE with OW_ORIGIN of reviewed main server')
  }
  const url = new URL(origin)
  if (
    url.origin !== origin ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('Use an explicit local native server origin')
  }
  await proof(stage, output, origin)
}
