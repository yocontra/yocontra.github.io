/** Dev-source native environment capture: all17 acts in one app, GPU retention and authored clock. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

function requireScene(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const origin = process.argv[2] ?? 'http://127.0.0.1:4390'
const output = process.env.OW_ENV_OUTPUT ?? '/tmp/out-west-environment-campaign'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') {
    errors.push(message.text())
  }
})
try {
  await mkdir(output, { recursive: true })
  await page.route('**/__environment_probe', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }),
  )
  // Snapshot inspection must not be interrupted by unrelated authors' HMR or open a dev socket.
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: 'export const createHotContext=()=>({accept(){},dispose(){},on(){},off(){},send(){},prune(){},invalidate(){}});export const injectQuery=u=>u;export const updateStyle=()=>{};export const removeStyle=()=>{};',
    }),
  )
  await page.goto(`${origin}/__environment_probe`, { waitUntil: 'domcontentloaded' })
  const setup = await page.evaluate(async () => {
    const applicationPath = '/src/experiments/out-west/client/application.ts'
    const arenasPath = '/src/experiments/out-west/duel/native-arenas.ts'
    const manifestPath = '/src/experiments/out-west/content/manifest.ts'
    const outlawsPath = '/src/experiments/out-west/data/outlaws.ts'
    const [{ GameApplication }, { NativeArenas, arenaForSlot }, { ASSETS }, { OUTLAWS }] =
      await Promise.all([
        import(applicationPath),
        import(arenasPath),
        import(manifestPath),
        import(outlawsPath),
      ])
    document.body.innerHTML =
      '<div id="view" style="position:fixed;inset:0"><canvas id="canvas"></canvas></div>'
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas')
    const viewport = document.querySelector<HTMLElement>('#view')
    if (!(canvas && viewport)) {
      throw new Error('Missing native viewport')
    }
    const game = await GameApplication.create({ canvas, viewport })
    const vram = game.app.graphicsDevice._vram
    let textureBytes = vram.tex
    const allocation = { peak: textureBytes }
    Object.defineProperty(vram, 'tex', {
      configurable: true,
      get: () => textureBytes,
      set: (value: number) => {
        textureBytes = value
        allocation.peak = Math.max(allocation.peak, value)
      },
    })
    await game.instantiate(ASSETS.duel.url, 'duel-street')
    const arenas = new NativeArenas(game)
    game.camera.setPosition(0, 4, -12)
    game.camera.lookAt(0, 5, 22)
    Reflect.set(globalThis, '__environmentProbe', {
      game,
      arenas,
      arenaForSlot,
      OUTLAWS,
      allocation,
    })
    return { engine: 'PlayCanvas', content: ASSETS.duel.hash }
  })
  const results: {
    level: number
    arena: string
    textureBytes: number
    textureAssets: number
    drawCalls: number
  }[] = []
  for (let level = 0; level < 17; level++) {
    const sample = await page.evaluate(async (index) => {
      const { game, arenas, arenaForSlot, OUTLAWS } = Reflect.get(globalThis, '__environmentProbe')
      await arenas.show(arenaForSlot(index))
      await arenas.lighting(OUTLAWS[index].day, index)
      for (let frame = 0; frame < 8; frame++) {
        await new Promise(requestAnimationFrame)
      }
      return {
        level: index + 1,
        arena: arenas.id,
        textureBytes: game.app.graphicsDevice._vram.tex,
        textureAssets: game.app.assets
          .list()
          .filter((asset: { type: string }) => asset.type === 'texture').length,
        drawCalls: game.app.stats.drawCalls.total,
      }
    }, level)
    results.push(sample)
    await page.screenshot({ path: `${output}/act-${String(level + 1).padStart(2, '0')}.png` })
  }
  const clock = await page.evaluate(async () => {
    const { game, arenas } = Reflect.get(globalThis, '__environmentProbe')
    const root = game.stage.findByName('town-clock-bell')
    const bone = root?.findByName('clock-3-8')
    if (!bone) {
      throw new Error('Missing native bell joint')
    }
    const before = bone.getLocalRotation().clone()
    arenas.toll()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = bone.getLocalRotation()
    game.camera.setPosition(5, 14, 49)
    game.camera.lookAt(0, 14, 63.5)
    return {
      changed: Math.hypot(
        before.x - after.x,
        before.y - after.y,
        before.z - after.z,
        before.w - after.w,
      ),
      state: root.find((node: object) => Boolean(Reflect.get(node, 'anim')))[0]?.anim?.baseLayer
        .activeState,
    }
  })
  await page.screenshot({ path: `${output}/native-clock.png` })
  requireScene(clock.changed > 0.01, 'Native bell animation never moved its joint')
  requireScene(clock.state === 'Toll', 'Bell clip did not play')
  const dailyFog = await page.evaluate(async () => {
    const { game, arenas } = Reflect.get(globalThis, '__environmentProbe')
    arenas.dailyFog(true)
    await arenas.lighting(0.6, 0)
    const first = { type: game.app.scene.fog.type, density: game.app.scene.fog.density }
    await arenas.lighting(1, 16)
    const boss = { type: game.app.scene.fog.type, density: game.app.scene.fog.density }
    arenas.dailyFog(false)
    return { first, boss, restored: game.app.scene.fog.type }
  })
  requireScene(
    [dailyFog.first, dailyFog.boss].every((fog) => fog.type === 'exp2' && fog.density === 0.07),
    'Daily fog was lost when the arena or boss lighting changed',
  )
  requireScene(dailyFog.restored === 'linear', 'Leaving Daily did not restore authored fog')
  const first = results[0]
  const returned = await page.evaluate(async () => {
    const { game, arenas, allocation } = Reflect.get(globalThis, '__environmentProbe')
    await arenas.show('street')
    await arenas.lighting(0, 0)
    for (let frame = 0; frame < 8; frame++) {
      await new Promise(requestAnimationFrame)
    }
    return {
      textureBytes: game.app.graphicsDevice._vram.tex,
      peakTextureBytes: allocation.peak,
      retainedSources: game.app.assets
        .list()
        .filter(
          (asset: { type: string; name: string }) =>
            asset.type === 'texture' && asset.name.includes('.hdr'),
        ).length,
    }
  })
  requireScene(first && results.length === 17, 'Campaign did not render all17 acts')
  requireScene(
    returned.textureBytes <= first.textureBytes + 2 * 1024 * 1024,
    'Inactive arena GPU textures accumulated across the campaign',
  )
  requireScene(returned.retainedSources === 0, 'Convolved source HDR remained on the GPU')
  requireScene(errors.length === 0, `Native environment errors: ${errors.join('; ')}`)
  const disposal = await page.evaluate(() => {
    const { game, arenas } = Reflect.get(globalThis, '__environmentProbe')
    arenas.destroy()
    game.destroy()
    document.querySelector('canvas')?.remove()
    return {
      entities: game.stage.children.length,
      canvases: document.querySelectorAll('canvas').length,
    }
  })
  requireScene(
    disposal.entities === 0 && disposal.canvases === 0,
    'Environment retained entities or canvas after disposal',
  )
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      {
        ...setup,
        scope: 'Environment and native clock only; no riders or physical-device FPS claim',
        results,
        returned,
        clock,
        dailyFog,
        disposal,
        errors,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({
      acts: results.length,
      peakTextureBytes: returned.peakTextureBytes,
      returnedTextureBytes: returned.textureBytes,
      clock,
      disposal,
    }),
  )
} finally {
  await browser.close()
}
