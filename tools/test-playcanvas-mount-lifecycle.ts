/** A pending character mount can be left without poisoning the next game in the same root. */
import { chromium } from 'playwright'
import type { FrontierHandle } from '../src/experiments/out-west/ffa/client/index.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 812, height: 375 }, hasTouch: true })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  let release: (() => void) | undefined
  let requested: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    requested = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route('**/baked/outlaw-0.glb?*', async (route) => {
    if (requests++ === 0) {
      requested?.()
      await gate
    }
    await route.continue().catch(() => undefined)
  })
  await page.goto(`${origin}/404`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async (path) => {
    const { mountFrontier } = await import(path)
    document.body.replaceChildren()
    document.body.style.margin = '0'
    const root = document.createElement('div')
    root.id = 'lifecycle-town'
    root.style.cssText = 'position:relative;width:100vw;height:100vh'
    document.body.append(root)
    const options = { server: 'loopback', bots: 0, seed: 7, spawn: { x: 72, z: 66 } }
    const first: FrontierHandle = mountFrontier(root, options)
    Reflect.set(globalThis, '__pendingTown', first)
    Reflect.set(globalThis, '__replaceTown', async () => {
      first.destroy()
      const next: FrontierHandle = mountFrontier(root, options)
      Reflect.set(globalThis, '__nextTown', next)
      await next.ready
    })
  }, '/src/experiments/out-west/ffa/client/index.ts')
  await pending
  await page.evaluate(() => Reflect.get(globalThis, '__replaceTown')())
  release?.()
  await page.evaluate(() => (Reflect.get(globalThis, '__pendingTown') as FrontierHandle).ready)
  const state = await page.evaluate(() => ({
    canvases: document.querySelectorAll('.pc-game-canvas').length,
    hud: document.querySelectorAll('.fr-hud').length,
    loading: document.querySelector('#lifecycle-town')?.classList.contains('pc-loading'),
    error: [...document.querySelectorAll<HTMLElement>('.pc-game-status')]
      .filter((node) => !node.hidden && node.getBoundingClientRect().height > 0)
      .map((node) => node.textContent),
    players: (Reflect.get(globalThis, '__nextTown') as FrontierHandle).debug().players,
  }))
  if (
    state.canvases !== 1 ||
    state.hud !== 1 ||
    state.loading ||
    state.error.length > 0 ||
    state.players !== 1
  ) {
    throw new Error(`Stale mount poisoned its replacement: ${JSON.stringify(state)}`)
  }
  await page.evaluate(() => (Reflect.get(globalThis, '__nextTown') as FrontierHandle).destroy())
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(JSON.stringify({ state, errors }))
} finally {
  await browser.close()
}
