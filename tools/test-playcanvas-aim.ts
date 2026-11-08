// biome-ignore-all lint/style/useNamingConvention: browser probes mirror the native engine and DEV hooks
/** Real native actor/equipment visibility at the player's actual look limits and across view switches. */
import { chromium } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'
import { DEFAULTS } from '../src/experiments/out-west/ffa/client/settings.ts'

interface Probe {
  __playcanvasFrontier?: GameViewport
  __nativeFrontierSession?: FrontierSession
}
const dynamicPath = /\/3d\/(?:native-v2\/)?dynamic\/(?<name>[^/]+)\.glb$/u
const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  const props = new Set<string>()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(dynamicPath)
    if (match?.groups?.name) {
      props.add(match.groups.name)
    }
  })
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&view=first&seed=7&spawn=72,66`,
  )
  await page.waitForFunction(() => (globalThis as Probe).__playcanvasFrontier, undefined, {
    timeout: 90_000,
  })
  await page.addStyleTag({ content: 'astro-dev-toolbar { display:none !important }' })
  const sample = () =>
    page.evaluate(async () => {
      const source = await (await fetch('/src/experiments/out-west/client/application.ts')).text()
      // biome-ignore lint/performance/useTopLevelRegex: the callback executes inside a separate browser realm
      const path = source.match(/from ["'](?<url>[^"']*playcanvas[^"']*)/u)?.groups?.url
      if (!path) {
        throw new Error('Missing native engine URL')
      }
      const pc: typeof import('playcanvas') = await import(/* @vite-ignore */ path)
      const applications = Reflect.get(pc.AppBase, '_applications')
      const app = Reflect.get(applications, '') as InstanceType<typeof pc.AppBase>
      const camera = app.root.findByName('camera')
      const models = app.root.find(
        (node) => Boolean(Reflect.get(node, 'anim')) && Boolean(node.parent?.tags.has('rider:0')),
      )
      const model = models[0] as InstanceType<typeof pc.Entity>
      const mount = app.root.find((node) => node.name === 'mount.WristR.drawn')[0]
      if (!(camera instanceof pc.Entity && camera.camera && mount && model.anim)) {
        throw new Error('Missing actual equipped native body, gun or camera')
      }
      const screen = camera.camera.worldToScreen(mount.getPosition(), new pc.Vec3())
      const session = (globalThis as Probe).__nativeFrontierSession
      return {
        screen: { x: screen.x, y: screen.y, z: screen.z },
        pitch: session?.world.players[session.selfSlot]?.pitch,
        bodies: models.length,
        drawn: mount.enabled,
        rotation: model.parent?.getEulerAngles().x,
        aim: model.anim.findAnimationLayer('Aim pitch')?.weight,
        pose: model.anim.findAnimationLayer('Aim pitch')?.activeState,
      }
    })
  const assertVisible = (state: Awaited<ReturnType<typeof sample>>) => {
    const { x, y, z } = state.screen
    if (!(z > 0 && x > 0 && x < 1280 && y > 0 && y < 720 && state.bodies === 1 && state.drawn)) {
      throw new Error(
        `Equipped first-person gun disappeared or duplicated: ${JSON.stringify(state)}`,
      )
    }
  }
  await page.mouse.click(640, 360)
  const samples: (Awaited<ReturnType<typeof sample>> & { name: string })[] = []
  for (const [name, y, sign] of [
    ['neutral', 360, 0],
    ['up', -1640, 1],
    ['down', 2360, -1],
  ] as const) {
    await page.mouse.move(640, y)
    await page.waitForFunction((direction) => {
      const session = (globalThis as Probe).__nativeFrontierSession
      const pitch = session?.world.players[session.selfSlot]?.pitch ?? 0
      return direction === 0 || pitch * direction >= 115
    }, sign)
    const state = await sample()
    assertVisible(state)
    samples.push({ name, ...state })
  }
  const switchTick = await page.evaluate(
    (settings) => {
      const state = globalThis as Probe
      state.__playcanvasFrontier?.configure(settings)
      return state.__nativeFrontierSession?.world.tick ?? 0
    },
    { ...DEFAULTS, view: 'third' as const },
  )
  await page.waitForFunction(
    (tick) => ((globalThis as Probe).__nativeFrontierSession?.world.tick ?? 0) > tick + 1,
    switchTick,
  )
  const third = await sample()
  if (
    Math.abs(third.rotation ?? 1) > 0.01 ||
    (third.aim ?? 0) < 0.98 ||
    third.pose !== 'Aim_Down'
  ) {
    throw new Error(`Third-person native pitch did not restore: ${JSON.stringify(third)}`)
  }
  await page.evaluate(
    (settings) => (globalThis as Probe).__playcanvasFrontier?.configure(settings),
    { ...DEFAULTS, view: 'first' as const },
  )
  await page.waitForFunction(
    (tick) => ((globalThis as Probe).__nativeFrontierSession?.world.tick ?? 0) > tick + 3,
    switchTick,
  )
  const returned = await sample()
  assertVisible(returned)
  const expectedProps = [
    'bag0',
    'bag1',
    'bag2',
    'bag3',
    'dynamite',
    'held-rifle',
    'held-shotgun',
    'rifle',
    'shotgun',
    'strongbox',
  ]
  if (
    JSON.stringify([...props].sort((a, b) => a.localeCompare(b))) !== JSON.stringify(expectedProps)
  ) {
    throw new Error(`Unexpected Frontier prop loading: ${JSON.stringify([...props])}`)
  }
  await page.evaluate(() => (globalThis as Probe).__playcanvasFrontier?.destroy())
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    JSON.stringify({
      samples,
      third,
      returned,
      props: [...props].sort((a, b) => a.localeCompare(b)),
      errors,
    }),
  )
} finally {
  await browser.close()
}
