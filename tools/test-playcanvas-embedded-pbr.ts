/** Matched native environment BRDF evidence. Human art review and FPS qualification remain separate. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ContainerResource, RenderComponent, StandardMaterial } from 'playcanvas'
import { chromium } from 'playwright'
import type { GameApplication as GameApp } from '../src/experiments/out-west/client/application.ts'
import type { NativeEnvironment as Environment } from '../src/experiments/out-west/client/environment.ts'
import { ASSETS as CONTENT } from '../src/experiments/out-west/content/manifest.ts'
import type { NativeArenas as Arenas } from '../src/experiments/out-west/duel/native-arenas.ts'
import { FRONTIER_VIEWS } from '../src/experiments/out-west/ffa/town.views.ts'
import { installShaderInspection, type SceneReview } from './content/embedded-pbr-proof.ts'

type MapName = 'frontier' | 'duel' | 'depot' | 'mission' | 'bank'
type Tier = 'low' | 'high'
interface Review {
  day: (day: number) => Promise<void>
  frame: (ggx: boolean, view: string) => Promise<unknown>
  dispose: () => unknown
}

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4394'
const output = resolve(process.env.OW_EVIDENCE ?? '/tmp/out-west-embedded-pbr')
const checkpoint = process.env.OW_PBR_CHECKPOINT === '1'
const maps: MapName[] = ['frontier', 'duel', 'depot', 'mission', 'bank']
const inputs = [
  import.meta.path,
  'tools/content/embedded-pbr-proof.ts',
  'src/experiments/out-west/client/application.ts',
  'src/experiments/out-west/client/environment.ts',
  'src/experiments/out-west/client/post.ts',
  'src/experiments/out-west/duel/native-arenas.ts',
  'src/experiments/out-west/content/manifest.ts',
  'src/experiments/out-west/ffa/town.views.ts',
  'node_modules/playcanvas/package.json',
  ...['playcanvas', 'playcanvas.dbg', 'playcanvas.prf'].flatMap((build) => [
    `node_modules/playcanvas/build/${build}.js`,
    `node_modules/playcanvas/build/${build}/src/scene/batching/batch.js`,
    `node_modules/playcanvas/build/${build}/src/scene/batching/batch-manager.js`,
  ]),
  ...maps.map((name) => `public${CONTENT[name].url.split('?')[0]}`),
]
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      inputs.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  )
const frozen = await hashes()
await mkdir(output) // Preserve earlier attempts; a capture directory must be new.
await writeFile(`${output}/inputs.json`, `${JSON.stringify(frozen, null, 2)}\n`)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
const errors: string[] = []
const diagnostics: string[] = []
const diagnosticStacks: unknown[] = []
const alignment =
  'ASSERT FAILED:  Non-interleaved vertex format with element size not multiple of 4 can have performance impact on some platforms. Element size: '
const results: unknown[] = []
const cleanup: unknown[] = []
const protocol = await page.context().newCDPSession(page)
await protocol.send('Runtime.enable')
protocol.on('Runtime.consoleAPICalled', (event) => {
  const text = event.args.map((argument) => String(argument.value)).join(' ')
  if ([3, 6].some((size) => text === `${alignment}${size}`)) {
    diagnosticStacks.push({ text, stack: event.stackTrace })
  }
})
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() !== 'error') {
    return
  }
  const text = message.text()
  if ([3, 6].some((size) => text === `${alignment}${size}`)) {
    diagnostics.push(text)
  } else {
    errors.push(text)
  }
})
const persist = async (failure?: unknown) =>
  writeFile(
    `${output}/receipt.json`,
    `${JSON.stringify(
      {
        status: failure
          ? 'FAILED; partial evidence retained'
          : 'native comparison; independent visual review required',
        checkpoint,
        diagnostics,
        diagnosticStacks,
        inputs: frozen,
        results,
        cleanup,
        errors,
        failure: failure === undefined ? undefined : String(failure),
        limits:
          'Static headless native BRDF comparison, warmed shader variants; no FPS or final art acceptance.',
      },
      null,
      2,
    )}\n`,
  )
try {
  await page.route('**/__embedded_pbr', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body style="margin:0"></body>',
    }),
  )
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export const createHotContext = () => ({ accept(){}, dispose(){}, on(){}, off(){}, send(){}, prune(){}, invalidate(){} });
export const injectQuery = value => value;
export const updateStyle = () => {};
export const removeStyle = () => {};`,
    }),
  )
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await page.goto(`${origin}/__embedded_pbr`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(installShaderInspection)
  for (const tier of (checkpoint ? ['low'] : ['low', 'high']) as Tier[]) {
    for (const map of checkpoint ? maps.slice(0, 1) : maps) {
      const setup = await page.evaluate(createScene, {
        map,
        tier,
        survey: FRONTIER_VIEWS.filter((view) =>
          ['main-west-east', 'facade-saloon'].includes(view.name),
        ),
      })
      await page.evaluate(installReview)
      results.push({ map, tier, setup })
      let disposed: unknown
      try {
        for (const day of [0.3, 0.75, 1]) {
          await page.evaluate(
            (time) => (Reflect.get(globalThis, '__embeddedPbr') as Review).day(time),
            day,
          )
          for (const view of setup.views) {
            // Warm both native variants before any resource comparison; compilation is not frame timing.
            for (const ggx of [false, true]) {
              await page.evaluate(
                ({ ggx: enabled, view: angle }) =>
                  (Reflect.get(globalThis, '__embeddedPbr') as Review).frame(enabled, angle),
                { ggx, view },
              )
            }
            const pair: unknown[] = []
            for (const ggx of [false, true]) {
              const frame = await page.evaluate(
                ({ ggx: enabled, view: angle }) =>
                  (Reflect.get(globalThis, '__embeddedPbr') as Review).frame(enabled, angle),
                { ggx, view },
              )
              const shaders = await page.evaluate(() =>
                Reflect.get(globalThis, '__embeddedPbrShaders'),
              )
              const image = `${tier}-${map}-${day}-${view}-${ggx ? 'ggx' : 'blinn'}.png`
              await page.screenshot({ path: `${output}/${image}` })
              pair.push(frame)
              results.push({ map, tier, day, view, ggx, image, frame, shaders })
              await persist()
            }
            if (JSON.stringify(pair[0]) !== JSON.stringify(pair[1])) {
              throw new Error(
                `Authored fields/maps/resources/draws changed across BRDF pair: ${tier}/${map}/${day}/${view}`,
              )
            }
          }
        }
      } finally {
        disposed = await page.evaluate(() =>
          (Reflect.get(globalThis, '__embeddedPbr') as Review).dispose(),
        )
        cleanup.push({ map, tier, disposed })
        await persist()
      }
      if (JSON.stringify(disposed) !== JSON.stringify({ textures: 0, buffers: 0 })) {
        throw new Error(`Environment disposal retained GPU resources: ${JSON.stringify(disposed)}`)
      }
    }
  }
  if (JSON.stringify(frozen) !== JSON.stringify(await hashes())) {
    throw new Error('Inputs changed during capture')
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  await persist()
} catch (failure) {
  await page
    .evaluate(() =>
      (Reflect.get(globalThis, '__embeddedActiveGame') as GameApp | undefined)?.destroy(),
    )
    .catch(() => undefined)
  await persist(failure)
  throw failure
} finally {
  await browser.close()
}

async function createScene({
  map,
  tier,
  survey,
}: {
  map: MapName
  tier: Tier
  survey: typeof FRONTIER_VIEWS
}) {
  const application = '/src/experiments/out-west/client/application.ts'
  const arenasPath = '/src/experiments/out-west/duel/native-arenas.ts'
  const environmentPath = '/src/experiments/out-west/client/environment.ts'
  const manifest = '/src/experiments/out-west/content/manifest.ts'
  const [{ GameApplication }, { NativeArenas }, { NativeEnvironment }, { ASSETS }] =
    await Promise.all([
      import(application),
      import(arenasPath),
      import(environmentPath),
      import(manifest),
    ])
  document.body.innerHTML =
    '<div id="view" style="position:fixed;inset:0"><canvas id="canvas"></canvas></div>'
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')
  const viewport = document.querySelector<HTMLElement>('#view')
  if (!(canvas && viewport)) {
    throw new Error('Missing viewport')
  }
  const game: GameApp = await GameApplication.create({
    canvas,
    viewport,
    tier,
    pixelRatio: 1,
  })
  Reflect.set(globalThis, '__embeddedActiveGame', game)
  game.app.timeScale = 0
  game.app.off('update', Reflect.get(game, 'update')) // Keep the requested resolution through shader warmup.
  game.app.soundManager.volume = 0
  let arenas: Arenas | undefined
  let environment: Environment
  const sources = new Set<StandardMaterial>()
  const imported: unknown[] = []
  const source = async (name: MapName) => {
    const asset = await game.loadContainer(ASSETS[name].url)
    const hook = String(Reflect.get(asset.options, 'material')?.postprocess)
    if (!hook.includes('enableGGXSpecular')) {
      throw new Error('Executing loader lacks embedded GGX hook')
    }
    const resource = asset.resource as ContainerResource
    for (const entry of resource.materials) {
      const material = entry.resource as StandardMaterial
      if (material.useLighting) {
        sources.add(material)
      }
    }
    imported.push({ name, hash: ASSETS[name].hash, hook, materials: resource.materials.length })
    return asset
  }
  if (map === 'frontier') {
    const town = await game.instantiate(ASSETS.frontier.url, 'town')
    environment = new NativeEnvironment(game, true)
    environment.attach(town, await source('frontier'))
    await environment.ready
  } else {
    await game.instantiate(ASSETS.duel.url, 'duel-street')
    await source('duel')
    arenas = new NativeArenas(game)
    await (arenas as Arenas).show(map === 'duel' ? 'street' : map)
    if (map !== 'duel') {
      await source(map)
    }
    environment = Reflect.get(arenas as Arenas, 'environment') as Environment
  }
  const clones = [...(Reflect.get(environment, 'materials') as Set<StandardMaterial>)].filter(
    (material) => material.useLighting,
  )
  const materials = new Set([...sources, ...clones])
  if (materials.size === 0 || ![...materials].every((material) => material.enableGGXSpecular)) {
    throw new Error('Imported PBR/source/environment clones do not all use native GGX')
  }
  const renders = () => game.app.root.findComponents('render') as RenderComponent[]
  const cameras: SceneReview['cameras'] =
    map === 'frontier'
      ? Object.fromEntries(
          survey.map((view) => [
            view.name,
            { position: view.from, target: view.to, fov: view.fov ?? 60 },
          ]),
        )
      : { wide: { position: [0, 3, -10], target: [0, 3, 22] } }
  if (map === 'frontier') {
    game.camera.setPosition(52, 1.7, 52)
  }
  const crate = renders()
    .flatMap((render) => render.meshInstances)
    .filter((instance) => instance.node.name.toLowerCase().includes('crate'))
    .sort(
      (a, b) =>
        a.aabb.center.distance(game.camera.getPosition()) -
        b.aabb.center.distance(game.camera.getPosition()),
    )[0]
  if (crate) {
    const { x, y, z } = crate.aabb.center
    cameras.crate = {
      position: map === 'frontier' ? [x + 3.3, y + 1.5, z + 3.3] : [x + 2.2, y + 1, z - 2.2],
      target: [x, y, z],
      fov: 40,
    }
  }
  Reflect.set(globalThis, '__embeddedScene', {
    game,
    arenas,
    environment,
    sources,
    clones,
    materials,
    cameras,
  })
  const batchCreate = String(Reflect.get(game.app.batcher, 'create'))
  const batches = Reflect.get(game.app.batcher, '_batchList') as object[]
  const batchDestroy = [
    ...new Set(
      batches.map((batch) => String(Reflect.get(Object.getPrototypeOf(batch), 'destroy'))),
    ),
  ]
  if (
    batchDestroy.length === 0 ||
    [batchCreate, ...batchDestroy].some((body) => !body.includes('_ownedMaterial'))
  ) {
    throw new Error('Executing optimized engine lacks owned batch-material teardown')
  }
  return {
    imported,
    sources: sources.size,
    clones: clones.length,
    views: Object.keys(cameras),
    engineMethods: { batchCreate, batchDestroy },
    pipeline: map === 'frontier' ? 'NativeEnvironment' : 'NativeArenas',
  }
}

function installReview() {
  const { game, arenas, environment, sources, clones, materials, cameras } = Reflect.get(
    globalThis,
    '__embeddedScene',
  ) as SceneReview
  const ids = new WeakMap<object, number>()
  let next = 0
  const id = (value: object) => {
    const result = ids.get(value) ?? ++next
    ids.set(value, result)
    return result
  }
  const snapshot = (material: StandardMaterial) => ({
    id: id(material),
    name: material.name,
    colors: [material.diffuse.toArray(), material.emissive.toArray()],
    scalars:
      'gloss metalness bumpiness aoIntensity opacity alphaTest cull blendType reflectivity emissiveIntensity'
        .split(' ')
        .map((key) => Reflect.get(material, key)),
    flags: [material.glossInvert, material.useLighting, material.useMetalness],
    maps: 'diffuse normal gloss metalness ao opacity emissive diffuseDetail'
      .split(' ')
      .map((slot) => {
        const texture = Reflect.get(material, `${slot}Map`)
        return {
          slot,
          texture: texture
            ? { id: id(texture), name: texture.name, width: texture.width, height: texture.height }
            : null,
          uv: Reflect.get(material, `${slot}MapUv`),
          channel: Reflect.get(material, `${slot}MapChannel`),
          offset: Reflect.get(material, `${slot}MapOffset`)?.toArray(),
          tiling: Reflect.get(material, `${slot}MapTiling`)?.toArray(),
          rotation: Reflect.get(material, `${slot}MapRotation`),
        }
      }),
  })
  Reflect.set(Reflect.get(globalThis, '__embeddedScene'), 'identity', id)
  const renders = () => game.app.root.findComponents('render') as RenderComponent[]
  const others = [
    ...new Set([
      ...game.app.assets
        .list()
        .filter((asset) => asset.type === 'material')
        .map((asset) => asset.resource as StandardMaterial),
      ...renders().flatMap((render) =>
        render.meshInstances.map((instance) => instance.material as StandardMaterial),
      ),
    ]),
  ].filter((material) => !materials.has(material))
  const device = game.app.graphicsDevice
  game.app.autoRender = false
  const warmRender = async () => {
    for (let frame = 0; frame < 4; frame++) {
      await new Promise<void>((done) => requestAnimationFrame(() => done()))
      game.app.render()
    }
  }
  let initial: string
  const fields = () => ({
    sources: [...sources].map(snapshot),
    clones: clones.map(snapshot),
    others: others.map((material) => ({ ...snapshot(material), ggx: material.enableGGXSpecular })),
  })
  const review: Review = {
    day: async (day) => {
      if (arenas) {
        await arenas.lighting(day)
      } else {
        await environment.setTime(day)
      }
      await warmRender()
      initial = JSON.stringify(fields())
    },
    frame: async (ggx, view) => {
      const camera = cameras[view]
      if (!camera) {
        throw new Error('Unknown view')
      }
      game.camera.setPosition(camera.position[0], camera.position[1], camera.position[2])
      game.camera.lookAt(camera.target[0], camera.target[1], camera.target[2])
      if (game.camera.camera) {
        game.camera.camera.fov = camera.fov ?? 58
      }
      for (const material of materials) {
        material.enableGGXSpecular = ggx
        material.update()
      }
      await warmRender()
      const current = fields()
      if (JSON.stringify(current) !== initial) {
        throw new Error('Authored material fields/maps or unrelated assets changed')
      }
      await Reflect.get(globalThis, '__embeddedInspectShaders')(ggx)
      return {
        fields: current,
        assets: game.app.assets.list().length,
        textures: device.textures.size,
        textureBytes: device._vram.tex,
        buffers: device.buffers.size,
        draws: game.app.stats.drawCalls.total,
        camera,
        resolution: [device.width, device.height],
        timeScale: game.app.timeScale,
      }
    },
    dispose: () => {
      arenas?.destroy()
      if (!arenas) {
        environment.destroy()
      }
      game.destroy()
      Reflect.deleteProperty(globalThis, '__embeddedActiveGame')
      return { textures: device.textures.size, buffers: device.buffers.size }
    },
  }
  Reflect.set(globalThis, '__embeddedPbr', review)
}
