// biome-ignore-all lint/style/useNamingConvention: these names match the existing DEV browser hooks
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: timed controls and physics lifecycle windows are intentionally measured
/** Actual production-page native Frontier regression. Desktop Chromium is a proxy, not device certification. */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'
import { DEFAULTS } from '../src/experiments/out-west/ffa/client/settings.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-client-evidence'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message.split('?')[0] ?? 'Page error'))
interface Probe {
  __playcanvasFrontier?: GameViewport
  __nativeFrontierSession?: FrontierSession
}
await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
const read = () =>
  page.evaluate(() => {
    const state = globalThis as Probe
    const session = state.__nativeFrontierSession
    const self = session?.world.players[session.selfSlot]
    return { debug: state.__playcanvasFrontier?.debug(), tick: session?.world.tick, self }
  })
try {
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=31&cluster&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => Boolean((globalThis as Probe).__playcanvasFrontier), undefined, {
    timeout: 90_000,
  })
  const initial = await read()
  if (initial.debug?.players !== 32) {
    throw new Error('Packed town did not contain32 riders')
  }
  await page.evaluate(() => (globalThis as Probe).__playcanvasFrontier?.tap(1))
  await page.waitForTimeout(700)
  const shot = await read()
  if (!(shot.self && initial.self) || shot.self.stats.shots <= initial.self.stats.shots) {
    throw new Error('Trigger input did not reach domain combat')
  }
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(700)
  await page.keyboard.up('KeyW')
  const moved = await read()
  if (!moved.self || Math.hypot(moved.self.x - shot.self.x, moved.self.z - shot.self.z) < 0.2) {
    throw new Error('Movement did not reach native domain motor')
  }
  await page.evaluate(() => {
    const state = globalThis as Probe
    const session = state.__nativeFrontierSession
    if (!session) {
      throw new Error('Missing native session')
    }
    for (const player of session.world.players
      .filter((p) => p && p.id !== session.selfSlot)
      .slice(0, 6)) {
      if (player) {
        player.hp = 0
        player.alive = false
        player.respawnTick = session.world.tick + 1000
      }
    }
  })
  await page.waitForTimeout(700)
  const dead = await read()
  if (
    dead.debug?.ragdolls.active !== 4 ||
    dead.debug.ragdolls.bodies !== 40 ||
    dead.debug.ragdolls.frozen < 2
  ) {
    throw new Error(`Native corpse bound failed: ${JSON.stringify(dead.debug?.ragdolls)}`)
  }
  await page.evaluate(() =>
    (globalThis as Probe).__nativeFrontierSession?.control(
      JSON.stringify({ type: 'practice_pause', on: true }),
    ),
  )
  await page.screenshot({ path: `${output}/native-packed32-corpses.png` })
  await page.waitForTimeout(4500)
  const frozen = await read()
  if (frozen.debug?.ragdolls.active !== 0 || frozen.debug.ragdolls.bodies !== 0) {
    throw new Error('Sleeping corpse bodies were not released')
  }
  await page.evaluate(() => {
    const state = globalThis as Probe
    for (const player of state.__nativeFrontierSession?.world.players ?? []) {
      if (player) {
        player.alive = true
        player.hp = 100
      }
    }
  })
  await page.evaluate(() =>
    (globalThis as Probe).__nativeFrontierSession?.control(
      JSON.stringify({ type: 'practice_pause', on: false }),
    ),
  )
  await page.waitForTimeout(300)
  const respawned = await read()
  if (respawned.debug?.ragdolls.frozen !== 0) {
    throw new Error('Respawn retained corpse poses')
  }
  const panes = await page.evaluate(() => {
    const state = globalThis as Probe
    const world = state.__nativeFrontierSession?.world
    const before = state.__playcanvasFrontier?.debug().windows.intact
    const index = world?.glass.indexOf(0) ?? -1
    if (world && index >= 0) {
      world.glass[index] = 1
    }
    return before
  })
  await page.waitForFunction(
    (before) =>
      (globalThis as Probe).__playcanvasFrontier?.debug().windows.intact === Number(before) - 1,
    panes,
  )
  await page.evaluate(() => {
    const session = (globalThis as Probe).__nativeFrontierSession
    if (!session) {
      throw new Error('Missing local showdown session')
    }
    const self = session.world.players[session.selfSlot]
    const enemy = session.world.players.find((player) => player?.bot && player.alive)
    if (!(self && enemy)) {
      throw new Error('Missing showdown participants')
    }
    Object.assign(self, { x: 72, z: 66, showdown: 60_000, lastButtons: 0 })
    Object.assign(enemy, { x: 73.5, z: 66, showdown: 60_000, lastButtons: 0 })
    session.world.showdowns.set(60_000, {
      id: 60_000,
      a: self.id,
      b: enemy.id,
      cx: 72.75,
      cz: 66,
      startTick: session.world.tick,
      callTick: session.world.tick + 4,
      fakeTicks: [],
      phase: 'wait',
    })
  })
  await page.waitForFunction(
    () =>
      (globalThis as Probe).__nativeFrontierSession?.world.showdowns.get(60_000)?.phase ===
      'called',
  )
  await page.waitForTimeout(120)
  await page.evaluate(() => (globalThis as Probe).__playcanvasFrontier?.tap(1))
  await page.waitForFunction(
    () => !(globalThis as Probe).__nativeFrontierSession?.world.showdowns.has(60_000),
  )
  const verdict = await read()
  if (!verdict.self?.alive) {
    throw new Error('Valid local showdown draw did not beat bot reaction')
  }
  await page.evaluate(
    (settings) => (globalThis as Probe).__playcanvasFrontier?.configure(settings),
    { ...DEFAULTS, view: 'top' as const },
  )
  await page.mouse.move(640, 100)
  await page.waitForFunction(() => {
    const session = (globalThis as Probe).__nativeFrontierSession
    const angle = session?.world.players[session.selfSlot]?.aim ?? 0
    return Math.abs(angle - 49_152) < 500
  })
  await page.screenshot({ path: `${output}/native-top-view.png` })
  await page.evaluate(
    (settings) => (globalThis as Probe).__playcanvasFrontier?.configure(settings),
    { ...DEFAULTS, view: 'first' as const },
  )
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${output}/native-first-person.png` })
  await page.evaluate(() => (globalThis as Probe).__playcanvasFrontier?.destroy())
  if (await page.locator('.pc-game-canvas').count()) {
    throw new Error('Unmount retained canvas')
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    JSON.stringify(
      {
        mode: 'packed32',
        initial: initial.debug,
        active: dead.debug,
        settled: frozen.debug,
        errors,
      },
      null,
      2,
    ),
  )
  const mobile = await browser.newPage({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  mobile.on('pageerror', (error) => errors.push(error.message.split('?')[0] ?? 'Mobile page error'))
  await mobile.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await mobile.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=1&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await mobile.waitForFunction(
    () => Boolean((globalThis as Probe).__playcanvasFrontier),
    undefined,
    { timeout: 90_000 },
  )
  const autoFire = await mobile.evaluate(
    (settings) => {
      const state = globalThis as Probe
      state.__playcanvasFrontier?.configure(settings)
      const session = state.__nativeFrontierSession
      if (!session) {
        throw new Error('Missing touch session')
      }
      const self = session.world.players[session.selfSlot]
      const enemy = session.world.players.find((player) => player?.bot)
      if (!(self && enemy)) {
        throw new Error('Missing touch target')
      }
      Object.assign(self, { x: 72, z: 66, aim: 0, fireCooldownMs: 0, protectUntil: 0 })
      Object.assign(enemy, {
        x: 75,
        z: 66,
        alive: true,
        hp: 100,
        protectUntil: 0,
        lingerUntil: session.world.tick + 10_000,
      })
      return self.stats.shots
    },
    { ...DEFAULTS, autoFire: true },
  )
  await mobile.waitForFunction(
    (before) => {
      const session = (globalThis as Probe).__nativeFrontierSession
      return (session?.world.players[session.selfSlot]?.stats.shots ?? 0) > Number(before)
    },
    autoFire,
    { timeout: 5000 },
  )
  for (const name of ['ROLL', 'JUMP', 'CROUCH', 'RELOAD', 'AIM', 'FIRE']) {
    if (!(await mobile.getByRole('button', { name, exact: true }).isVisible())) {
      throw new Error(`Missing primary touch action: ${name}`)
    }
  }
  await mobile.evaluate(() => {
    const session = (globalThis as Probe).__nativeFrontierSession
    const self = session?.world.players[session.selfSlot]
    const bank = session?.world.layout.zones.find((zone) => zone.kind === 'bank')
    if (!(session && self && bank)) {
      throw new Error('Missing contextual action fixture')
    }
    Object.assign(self, {
      x: bank.x,
      z: bank.z,
      carried: 100,
      dynamite: 1,
      calledBy: 1,
      calledUntil: session.world.tick + 10_000,
    })
  })
  await mobile.getByRole('button', { name: 'USE', exact: true }).waitFor()
  for (const name of ['USE', 'CALL', 'ROLL', 'THROW', 'JUMP', 'CROUCH', 'RELOAD', 'AIM', 'FIRE']) {
    if (!(await mobile.getByRole('button', { name, exact: true }).isVisible())) {
      throw new Error(`Missing touch action: ${name}`)
    }
  }
  await mobile.screenshot({ path: `${output}/native-touch-auto-fire.png` })
  await mobile.evaluate(() => (globalThis as Probe).__playcanvasFrontier?.destroy())
  await mobile.close()
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    'Native touch auto fire and all nine gameplay actions passed (desktop mobile emulation).',
  )
  if (process.env.OW_API) {
    const api = process.env.OW_API
    const fixture = (await fetch(`${api}/__test/seed`).then((response) => response.json())) as {
      token: string
    }
    let connections = 0
    let disconnect: (() => void) | undefined
    await page.routeWebSocket('**/town/**', (socket) => {
      socket.connectToServer()
      connections++
      disconnect = () => socket.close({ code: 1012, reason: 'Local reconnect regression' })
    })
    const url = new URL('/experiments/out-west/frontier/', origin)
    url.searchParams.set('server', 'remote')
    url.searchParams.set('api', api)
    url.searchParams.set('token', fixture.token)
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => Boolean((globalThis as Probe).__playcanvasFrontier),
      undefined,
      {
        timeout: 90_000,
      },
    )
    const online = await read()
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(1000)
    await page.keyboard.up('KeyW')
    const authoritative = await read()
    if (
      !(online.self && authoritative.self) ||
      Math.hypot(online.self.x - authoritative.self.x, online.self.z - authoritative.self.z) < 0.2
    ) {
      throw new Error('Remote input did not move authoritative state')
    }
    await page.evaluate(() => (globalThis as Probe).__playcanvasFrontier?.tap(1))
    await page.waitForTimeout(500)
    const fired = await read()
    if (!fired.self || fired.self.stats.shots <= authoritative.self.stats.shots) {
      throw new Error('Remote trigger did not produce authoritative combat')
    }
    const previousConnections = connections
    disconnect?.()
    await page.waitForTimeout(2500)
    if (connections <= previousConnections) {
      throw new Error('Disconnect did not reserve a fresh socket')
    }
    const resumed = await read()
    await page.waitForTimeout(700)
    const advancing = await read()
    if (!(resumed.tick && advancing.tick) || advancing.tick <= resumed.tick) {
      throw new Error('Fresh connection did not resume state updates')
    }
    await page.screenshot({ path: `${output}/native-authenticated-remote.png` })
    await page.evaluate(() => (globalThis as Probe).__playcanvasFrontier?.destroy())
    if (errors.length > 0) {
      throw new Error(errors.join('\n'))
    }
    console.log(
      JSON.stringify(
        {
          mode: 'authenticated-remote',
          connections,
          movement: authoritative.self.stats,
          fired: fired.self.stats,
          before: resumed.debug,
          after: advancing.debug,
          errors,
        },
        null,
        2,
      ),
    )
  }
} catch (error) {
  console.error(await page.locator('body').textContent())
  throw error
} finally {
  await browser.close()
}
