/** Headless staged native freight comparison. Images require independent art acceptance. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type * as Pc from 'playcanvas'
import { ADDRESS_REPEAT, FILTER_LINEAR, PIXELFORMAT_RGBA8 } from 'playcanvas'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { frozenFreightReview } from './content/freight-crates-candidate.ts'
import { freightWorldUv } from './content/freight-crates-geometry.ts'
import {
  captureUvState,
  compareUvFrames,
  type NativeFreight,
  prepareUvWitness,
} from './content/freight-crates-proof.ts'

const jobDirectory = process.env.OW_FREIGHT_DIRECTORY
if (!jobDirectory) {
  throw new Error('Set OW_FREIGHT_DIRECTORY to a frozen external freight authoring job')
}
const directory = resolve(jobDirectory)
const witnessOnly = process.env.OW_FREIGHT_UV_ONLY === '1'
const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4395'
const output = resolve(process.env.OW_EVIDENCE ?? join(directory, 'native-review'))
const frozen = await frozenFreightReview(directory)
const proofSource = await readFile(import.meta.path)
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const runtimeSources = await Promise.all(
  [
    'src/experiments/out-west/client/application.ts',
    'src/experiments/out-west/client/environment.ts',
    'src/experiments/out-west/scene/native-materials.ts',
    'tools/content/freight-crates-proof.ts',
  ].map(async (path) => ({ path, sha256: digest(await readFile(path)) })),
)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const records: unknown[] = []
const lifecycle: unknown[] = []
const errors: string[] = []
const diagnostics: unknown[] = []
const diagnosticStacks: unknown[] = []
const alignment =
  'ASSERT FAILED:  Non-interleaved vertex format with element size not multiple of 4 can have performance impact on some platforms. Element size: '
const knownAlignment = (text: string) => [3, 6].some((size) => text === `${alignment}${size}`)
async function persist(failure?: unknown, partial?: unknown) {
  await writeFile(
    join(output, failure ? 'failure.json' : 'receipt.json'),
    `${JSON.stringify({ status: failure ? 'FAILED' : 'native evidence; art/FPS acceptance separate', provenance: frozen.provenance, runtimeSources, witnessOnly, proofSHA256: digest(proofSource), records, lifecycle, errors, diagnostics, diagnosticStacks, partial, failure: failure === undefined ? undefined : String(failure) }, null, 2)}\n`,
  )
}
await mkdir(output, { recursive: true })
try {
  for (const asset of (['baseline', 'candidate'] as const).slice(witnessOnly ? 1 : 0)) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    })
    let stage = 'bootstrap'
    const protocol = await page.context().newCDPSession(page)
    await protocol.send('Runtime.enable')
    protocol.on('Runtime.consoleAPICalled', (event) => {
      const text = event.args.map((a) => String(a.value)).join(' ')
      if (knownAlignment(text)) {
        diagnosticStacks.push({ asset, stage, text, stack: event.stackTrace })
      }
    })
    page.on('pageerror', (error) => errors.push(`${asset}:${stage}:${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const text = message.text()
        if (knownAlignment(text)) {
          diagnostics.push({ asset, stage, text, location: message.location() })
        } else {
          errors.push(`${asset}:${stage}:${text}`)
        }
      }
    })
    page.on('requestfailed', (request) =>
      errors.push(`${asset}:${stage}:${request.url()}:${request.failure()?.errorText}`),
    )
    await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/@vite/client') {
        return route.fulfill({
          contentType: 'text/javascript',
          body: `export const createHotContext = () => ({ accept(){}, dispose(){}, on(){}, off(){}, send(){}, prune(){}, invalidate(){} });
export const injectQuery = value => value;
export const updateStyle = () => {};
export const removeStyle = () => {};`,
        })
      }
      if (path === '/__freight/probe') {
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><body></body></html>',
        })
      }
      const bodies = new Map([
        ['/__freight/baseline.glb', frozen.baseline],
        ['/__freight/candidate.glb', frozen.candidate],
      ])
      const body = bodies.get(path)
      if (body) {
        return route.fulfill({ contentType: 'model/gltf-binary', body })
      }
      if (path.startsWith('/__freight/')) {
        return route.fulfill({ status: 404, body: 'Not allowed' })
      }
      return route.continue()
    })
    await page.goto(`${origin}/__freight/probe`)
    stage = 'native-load/attach'
    const execution = await page.evaluate(async (name) => {
      const applicationPath = '/src/experiments/out-west/client/application.ts'
      const environmentPath = '/src/experiments/out-west/client/environment.ts'
      const [{ GameApplication: Application }, { NativeEnvironment: Environment }] =
        await Promise.all([import(applicationPath), import(environmentPath)])
      document.body.innerHTML =
        '<div id="view" style="position:fixed;inset:0"><canvas id="canvas"></canvas></div>'
      const canvas = document.querySelector<HTMLCanvasElement>('#canvas')
      const viewport = document.querySelector<HTMLElement>('#view')
      if (!(canvas && viewport)) {
        throw new Error('Missing native freight viewport')
      }
      const game = (await Application.create({
        canvas,
        viewport,
        pixelRatio: 1,
      })) as NativeFreight['game']
      game.app.timeScale = 0
      const adaptiveUpdate = Reflect.get(game, 'update')
      if (typeof adaptiveUpdate !== 'function') {
        throw new Error('Missing application adaptive update callback')
      }
      game.app.off('update', adaptiveUpdate)
      const device = game.app.graphicsDevice
      device.maxPixelRatio = 1
      game.app.resizeCanvas(1280, 720)
      const environment = new Environment(game, true) as NativeFreight['environment']
      const town = await game.instantiate(`/__freight/${name}.glb`, 'Freight comparison town')
      environment.attach(town, await game.loadContainer(`/__freight/${name}.glb`))
      await environment.ready
      game.app.soundManager.volume = 0
      const group = game.app.batcher?.getGroupByName('environment')
      const batches = group
        ? Reflect.get(game.app.batcher, 'getBatches').call(game.app.batcher, group.id)
        : []
      const materialStates = [
        ...new Set(
          (town.findComponents('render') as Pc.RenderComponent[]).flatMap((component) =>
            component.meshInstances.map((instance) => {
              if (!instance.material) {
                throw new Error('Missing native freight material')
              }
              return instance.material
            }),
          ),
        ),
      ].map((material) => ({
        name: material.name,
        ggx: Reflect.get(material, 'enableGGXSpecular') === true,
        normal: Boolean(Reflect.get(material, 'normalMap')),
        roughness: Boolean(Reflect.get(material, 'glossMap')),
        metalness: Boolean(Reflect.get(material, 'metalnessMap')),
      }))
      if (
        materialStates.some(
          (material) =>
            (material.normal || material.roughness || material.metalness) && !material.ggx,
        )
      ) {
        throw new Error('Freight PBR renderer is not the accepted GGX baseline')
      }
      const bodies = {
        resolution: [device.width, device.height],
        timeScale: game.app.timeScale,
        materialStates,
        create: game.app.batcher?.create.toString() ?? '',
        destroy: batches[0] ? (Object.getPrototypeOf(batches[0]).destroy.toString() as string) : '',
      }
      Reflect.set(globalThis, '__freightNative', {
        game,
        environment,
        town,
        device,
        execution: bodies,
      } satisfies NativeFreight)
      if (
        !(bodies.create.includes('_ownedMaterial') && bodies.destroy.includes('_ownedMaterial'))
      ) {
        throw new Error('Freight executing engine ownership gate failed')
      }
      return bodies
    }, asset)
    await writeFile(
      join(output, `${asset}-engine-execution.json`),
      `${JSON.stringify({ createSHA256: digest(execution.create), destroySHA256: digest(execution.destroy), ...execution }, null, 2)}\n`,
    )
    if (!witnessOnly) {
      for (const day of [0.3, 0.9]) {
        await page.evaluate(async (time) => {
          await (Reflect.get(globalThis, '__freightNative') as NativeFreight).environment.setTime(
            time,
          )
        }, day)
        stage = `capture:${day}`
        for (const placement of frozen.job.placements.filter((entry) =>
          (frozen.job.selected.length > 1 ? [190, 221, 224, 230] : frozen.job.selected).includes(
            entry.coverIndex,
          ),
        )) {
          for (const view of [
            { id: 'front', distance: 3, side: 0 },
            { id: 'corner', distance: 3, side: 1 },
            { id: 'top', distance: 1, side: 1 },
            { id: 'wide', distance: 12, side: 1 },
          ]) {
            const observation = await page.evaluate(
              async ({ box, camera }) => {
                const { game, town, device } = Reflect.get(
                  globalThis,
                  '__freightNative',
                ) as NativeFreight
                const x = (box.min[0] + box.max[0]) / 2
                const z = (box.min[2] + box.max[2]) / 2
                const target = [x, (box.min[1] + box.max[1]) / 2, z] as [number, number, number]
                const top = camera.id === 'top'
                const eye = [
                  x - camera.side * camera.distance,
                  box.max[1] + (top ? 3 : 1),
                  top ? z + 0.5 : box.max[2] + camera.distance,
                ] as [number, number, number]
                game.camera.setPosition(...eye)
                game.camera.lookAt(...target)
                if (!game.camera.camera) {
                  throw new Error('Missing freight lens')
                }
                game.camera.camera.fov = 55
                game.camera.camera.nearClip = 0.02
                const resolutions: number[][] = []
                for (let frame = 0; frame < 3; frame++) {
                  await new Promise<void>((done) => requestAnimationFrame(() => done()))
                  resolutions.push([device.width, device.height])
                  if (device.width !== 1280 || device.height !== 720 || game.app.timeScale !== 0) {
                    throw new Error('Freight frame resolution/clock changed')
                  }
                }
                const components = town.findComponents('render') as Pc.RenderComponent[]
                const lods = components
                  .filter((component) =>
                    component.entity.path
                      .split('/')
                      .some((segment) => segment.endsWith(`:freight-${box.coverIndex}`)),
                  )
                  .map((component) => ({
                    path: component.entity.path,
                    enabled: component.enabled,
                    meshes: component.meshInstances.length,
                  }))
                return {
                  eye,
                  target,
                  fov: game.camera.camera.fov,
                  resolutions,
                  resolution: [device.width, device.height],
                  timeScale: game.app.timeScale,
                  textures: device.textures.size,
                  buffers: device.buffers.size,
                  textureBytes: Reflect.get(device, '_vram').tex as number,
                  drawCalls: game.app.stats.drawCalls.total,
                  lods,
                }
              },
              { box: placement, camera: view },
            )
            if (asset === 'candidate' && observation.lods.length === 0) {
              throw new Error('Staged freight LOD components were not loaded')
            }
            const file = `${asset}-${placement.coverIndex}-${day}-${view.id}.png`
            await page.screenshot({ path: join(output, file) })
            records.push({
              asset,
              day,
              coverIndex: placement.coverIndex,
              view: view.id,
              file,
              ...observation,
            })
          }
        }
      }
      await page.evaluate(async () => {
        const { game } = Reflect.get(globalThis, '__freightNative') as NativeFreight
        await (Reflect.get(globalThis, '__freightNative') as NativeFreight).environment.setTime(0.3)
        game.camera.setPosition(8, 30, 8)
        game.camera.lookAt(52, 0, 52)
        if (game.camera.camera) {
          game.camera.camera.fov = 55
        }
        for (let i = 0; i < 3; i++) {
          await new Promise<void>((done) => requestAnimationFrame(() => done()))
        }
      })
      await page.screenshot({ path: join(output, `${asset}-fullscene.png`) })
      // Both hysteresis directions use the real NativeModelLods update path and static batcher.
    }
    if (!witnessOnly && asset === 'candidate') {
      const placement = frozen.job.placements.find((entry) =>
        frozen.job.selected.includes(entry.coverIndex),
      )
      if (!placement) {
        throw new Error('Missing freight LOD transition fixture')
      }
      for (const [step, distance] of [13, 11, 9, 7, 9, 11, 13].entries()) {
        stage = `lod:${step}:${distance}`
        const transition = await page.evaluate(
          async ({ box, radius }) => {
            const { game, town, device } = Reflect.get(
              globalThis,
              '__freightNative',
            ) as NativeFreight
            const center = box.min.map((value, axis) => (value + (box.max[axis] ?? 0)) / 2) as [
              number,
              number,
              number,
            ]
            game.camera.setPosition(center[0], center[1], center[2] - radius)
            game.camera.lookAt(...center)
            const resolutions: number[][] = []
            for (let frame = 0; frame < 3; frame++) {
              await new Promise<void>((done) => requestAnimationFrame(() => done()))
              resolutions.push([device.width, device.height])
              if (device.width !== 1280 || device.height !== 720 || game.app.timeScale !== 0) {
                throw new Error('Freight transition resolution/clock changed')
              }
            }
            const state = (town.findComponents('render') as Pc.RenderComponent[])
              .filter((component) =>
                component.entity.path
                  .split('/')
                  .some((segment) => segment.endsWith(`:freight-${box.coverIndex}`)),
              )
              .map((component) => ({ path: component.entity.path, enabled: component.enabled }))
            return { state, resolutions, timeScale: game.app.timeScale }
          },
          { box: placement, radius: distance },
        )
        const state = transition.state
        const near = state.filter((component) =>
          component.path.includes(`lod-near:freight-${placement.coverIndex}`),
        )
        const far = state.filter((component) =>
          component.path.includes(`lod-far:freight-${placement.coverIndex}`),
        )
        const expectedNear = step >= 3 && step <= 5
        if (
          !(
            near.length > 0 &&
            far.length > 0 &&
            near.every((component) => component.enabled === expectedNear) &&
            far.every((component) => component.enabled !== expectedNear)
          )
        ) {
          throw new Error(`Freight native LOD hysteresis failed at step ${step}`)
        }
        records.push({ asset, transitionDistance: distance, expectedNear, ...transition })
      }
    }
    if (asset === 'candidate') {
      const placement = frozen.job.placements.find(
        (entry) =>
          entry.coverIndex === (frozen.job.selected.includes(227) ? 227 : frozen.job.selected[0]),
      )
      if (!placement) {
        throw new Error('Missing authored UV witness placement')
      }
      for (const [mode, tier] of [
        ['unbatched', 'near'],
        ['batched', 'near'],
        ['unbatched', 'far'],
        ['batched', 'far'],
      ] as const) {
        stage = `world-reference:${mode}:${tier}`
        const cell = placement.cells[tier === 'near' ? 0 : Math.min(2, placement.cells.length - 1)]
        if (!cell) {
          throw new Error('Missing authored UV witness cell')
        }
        const input = await page.evaluate(prepareUvWitness, {
          mode,
          tier,
          cell,
          constants: { format: PIXELFORMAT_RGBA8, filter: FILTER_LINEAR, repeat: ADDRESS_REPEAT },
        })
        const worldState = await page.evaluate(captureUvState)
        const world = await page.screenshot({ path: join(output, `uv-${mode}-${tier}-world.png`) })
        const negative = await page.evaluate(() =>
          Reflect.get(globalThis, '__freightUvFrame')('negative', []),
        )
        const negativeState = await page.evaluate(captureUvState)
        const wrong = await page.screenshot({
          path: join(output, `uv-${mode}-${tier}-negative.png`),
        })
        await page.evaluate(
          async (values) => {
            await Reflect.get(globalThis, '__freightUvFrame')('reference', values)
          },
          input.streams.map((s) => Array.from(freightWorldUv(s.positions, s.matrix))),
        )
        const referenceState = await page.evaluate(captureUvState)
        const reference = await page.screenshot({
          path: join(output, `uv-${mode}-${tier}-reference.png`),
        })
        await page.evaluate(() => Reflect.get(globalThis, '__freightUvFrame')('hidden', []))
        const hidden = await page.screenshot({
          path: join(output, `uv-${mode}-${tier}-hidden.png`),
        })
        const bytes = await Promise.all(
          [world, reference, wrong, hidden].map((value) =>
            sharp(value).removeAlpha().raw().toBuffer(),
          ),
        )
        const { maximumError, negativePixels, hiddenPixels } = compareUvFrames(
          bytes[0],
          bytes[1],
          bytes[2],
          bytes[3],
        )
        records.push({
          asset,
          mode,
          tier,
          cell: cell.id,
          maximumError,
          negativePixels,
          hiddenPixels,
          isolated: input.isolated,
          negative,
          worldState,
          negativeState,
          referenceState,
          shaders: input.shaders,
          streamReferences: input.streams.map((s) => ({
            vertices: s.positions.length / 3,
            matrix: s.matrix,
            uvSHA256: digest(Buffer.from(freightWorldUv(s.positions, s.matrix).buffer)),
          })),
        })
        await page.evaluate(() => Reflect.get(globalThis, '__freightUvDispose')())
        if (maximumError > 2 || negativePixels < 64 || hiddenPixels < 64) {
          throw new Error(`World UV reference failed: ${maximumError}/${negativePixels}`)
        }
      }
    }
    const disposed = await page.evaluate(async (name) => {
      const { game, environment, town, device } = Reflect.get(
        globalThis,
        '__freightNative',
      ) as NativeFreight
      const before = { textures: device.textures.size, buffers: device.buffers.size }
      environment.destroy()
      town.destroy()
      game.releaseContainer(`/__freight/${name}.glb`)
      await Promise.resolve()
      game.destroy()
      const after = { textures: device.textures.size, buffers: device.buffers.size }
      const result = { before, after }
      Reflect.set(globalThis, '__freightDisposed', result)
      return result
    }, asset)
    lifecycle.push({ asset, ...disposed })
    await writeFile(
      join(output, 'partial.json'),
      `${JSON.stringify({ records, lifecycle, errors, diagnostics, diagnosticStacks }, null, 2)}\n`,
    )
    if (disposed.after.textures !== 0 || disposed.after.buffers !== 0) {
      throw new Error(
        `Freight native disposal retained resources: ${JSON.stringify(disposed.after)}`,
      )
    }
    await page.close()
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  await persist()
} catch (error) {
  const partial = await browser
    .contexts()[0]
    ?.pages()[0]
    ?.evaluate(() => ({ disposed: Reflect.get(globalThis, '__freightDisposed') ?? null }))
    .catch(() => null)
  await persist(error, partial)
  throw error
} finally {
  await browser.close()
}
