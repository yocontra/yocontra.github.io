/** Async arena/actor loads retain their renderer while another preview or physics app is current. */
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await page.goto(`${origin}/404`)
  const result = await page.evaluate(async () => {
    const applicationPath = '/src/experiments/out-west/client/application.ts'
    const arenasPath = '/src/experiments/out-west/duel/native-arenas.ts'
    const actorPath = '/src/experiments/out-west/duel/native-actor.ts'
    const manifestPath = '/src/experiments/out-west/content/manifest.ts'
    const { GameApplication }: typeof import('../src/experiments/out-west/client/application.ts') =
      await import(/* @vite-ignore */ applicationPath)
    const { NativeArenas }: typeof import('../src/experiments/out-west/duel/native-arenas.ts') =
      await import(/* @vite-ignore */ arenasPath)
    const { DuelActor }: typeof import('../src/experiments/out-west/duel/native-actor.ts') =
      await import(/* @vite-ignore */ actorPath)
    const { ASSETS }: typeof import('../src/experiments/out-west/content/manifest.ts') =
      await import(/* @vite-ignore */ manifestPath)
    const source = await (await fetch(applicationPath)).text()
    // biome-ignore lint/performance/useTopLevelRegex: this callback executes in the browser realm
    const enginePath = source.match(/from ["'](?<url>[^"']*playcanvas[^"']*)/u)?.groups?.url
    if (!enginePath) {
      throw new Error('Missing native engine URL')
    }
    const pc: typeof import('playcanvas') = await import(/* @vite-ignore */ enginePath)
    const viewport = document.createElement('div')
    viewport.style.cssText = 'width:400px;height:300px'
    document.body.append(viewport)
    const make = () => {
      const canvas = document.createElement('canvas')
      viewport.append(canvas)
      return GameApplication.create({ canvas, viewport })
    }
    const first = await make()
    const second = await make()
    const device = new pc.NullGraphicsDevice({ width: 1, height: 1 })
    const headless = new pc.AppBase(device.canvas)
    const options = new pc.AppOptions()
    options.graphicsDevice = device
    options.componentSystems = []
    headless.init(options)
    const arenas = new NativeArenas(first)
    try {
      await arenas.show('mission')
      const actor = await DuelActor.create(first, ASSETS.player.url, 'async-actor')
      const lamps = first.stage.children.filter((entity) => entity.name.startsWith('arena-lamp-'))
      if (
        lamps.length === 0 ||
        lamps.some(
          (entity) => !(entity instanceof pc.Entity && entity.light?.system.app === first.app),
        ) ||
        Reflect.get(actor.root, '_app') !== first.app ||
        Reflect.get(actor.model, '_app') !== first.app ||
        actor.model.anim?.system.app !== first.app
      ) {
        throw new Error('Async arena or actor attached to another native application')
      }
      headless.destroy()
      await arenas.show('bank')
      first.destroy()
      const preview = await second.instantiate(ASSETS.player.url, 'surviving-preview')
      if (Reflect.get(preview, '_app') !== second.app || !preview.findComponent('render')) {
        throw new Error('Disposing one renderer invalidated another preview')
      }
      return { lamps: lamps.length, actor: true, survivingPreview: true }
    } finally {
      arenas.destroy()
      first.destroy()
      second.destroy()
      viewport.remove()
    }
  })
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
