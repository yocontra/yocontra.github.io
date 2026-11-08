/** Sole-human loss retires authority; the real SDK joins a fresh world without stale feedback. */
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const api = process.env.OW_API ?? 'http://127.0.0.1:8792'
const seed = (await fetch(`${api}/__test/seed`).then((response) => response.json())) as {
  token: string
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (error) => errors.push(error.message))
  let reservations = 0
  let release: () => void = () => undefined
  const resumed = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/town/native/join', async (route) => {
    reservations++
    if (reservations === 2) {
      await resumed
    }
    await route.continue()
  })
  await page.addInitScript(() => {
    class NativeSocket extends WebSocket {
      constructor(socketUrl: string | URL, protocols?: string | string[]) {
        super(socketUrl, protocols)
        if (String(socketUrl).includes('/town/')) {
          Reflect.set(globalThis, '__reconnectSocket', this)
          Reflect.set(
            globalThis,
            '__reconnectConnections',
            Number(Reflect.get(globalThis, '__reconnectConnections') ?? 0) + 1,
          )
        }
      }
    }
    Reflect.set(globalThis, 'WebSocket', NativeSocket)
  })
  const url = new URL('/experiments/out-west/frontier/', origin)
  url.searchParams.set('server', 'remote')
  url.searchParams.set('api', api)
  url.searchParams.set('token', seed.token)
  await page.goto(url.href)
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')), null, {
    timeout: 90_000,
  })
  const read = () =>
    page.evaluate(() => {
      const session = Reflect.get(globalThis, '__nativeFrontierSession')
      const self = session.world.players[session.selfSlot]
      const pose = session.players.get(session.selfId)
      return {
        seed: session.world.seed,
        tick: session.world.tick,
        banked: session.banked,
        name: self.name,
        shots: self.stats.shots,
        pose: { x: pose.x, z: pose.z, vx: pose.vx, vz: pose.vz },
        debug: Reflect.get(globalThis, '__playcanvasFrontier').debug(),
      }
    })
  await page.evaluate(() => Reflect.get(globalThis, '__playcanvasFrontier').tap(1))
  await page.waitForFunction(() => {
    const s = Reflect.get(globalThis, '__nativeFrontierSession')
    return s.world.players[s.selfSlot].stats.shots > 0
  })
  const before = await read()
  console.info('before-close', JSON.stringify(before))
  await page.evaluate(() =>
    Reflect.get(globalThis, '__reconnectSocket').close(1000, 'Local sole-human reconnect test'),
  )
  await page.waitForFunction(() => document.querySelector('.pc-loading') !== null)
  let empty: unknown
  const transitions: unknown[] = []
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const timing = (await fetch(`${api}/__test/native-timing?lobbyId=lobby:0`).then((response) =>
      response.json(),
    )) as { humans: number; core: boolean; physics: boolean; lease: boolean; running: boolean }
    transitions.push(timing)
    if (
      timing.humans === 0 &&
      !timing.core &&
      !timing.physics &&
      !timing.lease &&
      !timing.running
    ) {
      const directory = await fetch(`${api}/town/lobbies`).then((response) => response.json())
      empty = { timing, directory }
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!empty) {
    await writeFile(
      '/tmp/out-west-freshroom-failed-transitions.json',
      JSON.stringify(transitions, null, 2),
    )
    throw new Error('Sole-human socket loss retained a native world, lease or running room')
  }
  console.info('empty-native', JSON.stringify(empty))
  release()
  await page.waitForFunction(() => document.querySelector('.pc-loading') === null)
  const after = await read()
  console.info('after-rejoin', JSON.stringify(after))
  const connections = await page.evaluate(() =>
    Number(Reflect.get(globalThis, '__reconnectConnections')),
  )
  if (
    after.banked !== before.banked ||
    after.name !== before.name ||
    after.shots !== 0 ||
    connections !== 2
  ) {
    throw new Error('Fresh-room reconnect lost account state or retained old combat state')
  }
  await page.keyboard.down('KeyW')
  await page.waitForFunction((start) => {
    const s = Reflect.get(globalThis, '__nativeFrontierSession')
    const p = s.players.get(s.selfId)
    return Math.hypot(p.x - start.x, p.z - start.z) > 0.3
  }, after.pose)
  await page.keyboard.up('KeyW')
  await page.evaluate(() => Reflect.get(globalThis, '__playcanvasFrontier').tap(1))
  await page.waitForFunction(() => {
    const s = Reflect.get(globalThis, '__nativeFrontierSession')
    return s.world.players[s.selfSlot].stats.shots === 1
  })
  const playable = await read()
  await page.evaluate(() => Reflect.get(globalThis, '__playcanvasFrontier').destroy())
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  const result = { before, empty, after, playable, connections, reservations, errors }
  await writeFile('/tmp/out-west-freshroom-reconnect.json', JSON.stringify(result, null, 2))
  console.info(JSON.stringify(result))
} finally {
  await browser.close()
}
