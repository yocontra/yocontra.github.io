/** Real practice-world death/respawn while a native remote appearance is still downloading. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = '/tmp/out-west-actor-combat-lifecycle'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
let release: () => void = () => undefined
const held = new Promise<void>((resolve) => {
  release = resolve
})
let requested: () => void = () => undefined
const loading = new Promise<void>((resolve) => {
  requested = resolve
})
let responses = 0
await page.route('**/baked/outlaw-1.glb?*', async (route) => {
  requested()
  await held
  await route.continue()
  responses++
})
const stats = () =>
  page.evaluate(() => (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug())
try {
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')),
    undefined,
    { timeout: 90_000 },
  )
  const id = await page.evaluate(async () => {
    const path = '/src/experiments/out-west/ffa/sim/world.ts'
    const { addPlayer } = await import(path)
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const slot = addPlayer(session.world, {
      accountId: 'late-model',
      name: 'Late model',
      level: 1,
      prestige: 0,
      bot: true,
    })
    const self = session.world.players[session.selfSlot]
    const player = session.world.players[slot]
    if (self && player) {
      player.x = self.x + 3
      player.z = self.z
      player.lingerUntil = session.world.tick + 10_000
    }
    return slot
  })
  if (id !== 1) {
    throw new Error('Unexpected practice slot')
  }
  await loading
  await page.waitForFunction(
    () =>
      (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors.fallbacks ===
      1,
  )
  await page.evaluate(async () => {
    const path = '/tools/content/actor-lifecycle-probe.ts'
    ;(await import(path)).rememberRider('1')
    const death = '/src/experiments/out-west/ffa/sim/death.ts'
    const { killPlayer } = await import(death)
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const target = session.world.players[1]
    if (!target) {
      throw new Error('Missing victim')
    }
    killPlayer(session.world, target, session.selfSlot)
    target.respawnTick = session.world.tick + 10_000
  })
  await page.waitForFunction(
    () =>
      (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().ragdolls.active ===
      1,
  )
  const dead = await stats()
  release()
  await page.waitForFunction(
    () =>
      (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors.loading ===
      0,
  )
  const same = await page.evaluate(async () => {
    const path = '/tools/content/actor-lifecycle-probe.ts'
    return (await import(path)).sameRider('1')
  })
  const late = await stats()
  if (!same || late.ragdolls.active !== 1 || late.actors.fallbacks !== 1) {
    throw new Error(`Late appearance replaced active corpse:${JSON.stringify({ same, late })}`)
  }
  await page.screenshot({ path: `${output}/dead-after-upgrade.png` })
  await page.evaluate(async () => {
    const path = '/src/experiments/out-west/ffa/sim/world.ts'
    const { spawnPlayer } = await import(path)
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const target = session.world.players[1]
    if (target) {
      spawnPlayer(session.world, target)
    }
  })
  await page.waitForFunction(
    () => {
      const state = (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug()
      return (
        state.actors.fallbacks === 0 &&
        state.actors.loading === 0 &&
        state.ragdolls.active === 0 &&
        state.ragdolls.frozen === 0
      )
    },
    undefined,
    { timeout: 45_000 },
  )
  const respawned = await stats()
  await page.screenshot({ path: `${output}/respawn-after-upgrade.png` })
  const changed = await page.evaluate(async () => {
    const path = '/tools/content/actor-lifecycle-probe.ts'
    return !(await import(path)).sameRider('1')
  })
  if (!changed || errors.length > 0) {
    throw new Error(`Respawn appearance failed:${JSON.stringify({ changed, errors })}`)
  }
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ dead, late, respawned, responses, errors }, null, 2),
  )
  console.log(
    'PASS native delayed-upgrade death/respawn lifecycle',
    JSON.stringify({ dead, late, respawned, responses, errors }),
  )
} finally {
  release()
  await browser.close()
}
