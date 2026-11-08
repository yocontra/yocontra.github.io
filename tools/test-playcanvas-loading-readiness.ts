/** A downloading rider cannot be targeted: no live seat exists before map and own gear are ready. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, type Page } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const api = process.env.OW_API ?? 'http://127.0.0.1:8792'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-loading-readiness'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
interface Account {
  token: string
  name: string
}
const errors: string[] = []
const observations: unknown[] = []
const seed = async (): Promise<Account> => {
  const response = await fetch(`${api}/__test/seed`)
  if (!response.ok) {
    throw new Error(`Local fixture seed: ${response.status}`)
  }
  return response.json() as Promise<Account>
}
function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function absent(page: Page, name: string): Promise<boolean> {
  return page.evaluate((target) => {
    const session = Reflect.get(globalThis, '__loadingObserver') as FrontierSession
    return !session.world.players.some((player) => player?.name === target)
  }, name)
}
try {
  const [observerAccount, targetAccount] = await Promise.all([seed(), seed()])
  const observer = await browser.newPage()
  observer.on('pageerror', (error) => errors.push(error.message))
  await observer.goto(`${origin}/404`, { waitUntil: 'domcontentloaded' })
  const lobby = await observer.evaluate(
    async ({ token, apiUrl, targetName }) => {
      const sessionPath = '/src/experiments/out-west/client/remote-session.ts'
      const collisionPath = '/src/experiments/out-west/content/collision.json?import'
      const [{ createRemoteFrontierSession }, { default: collision }] = await Promise.all([
        import(/* @vite-ignore */ sessionPath),
        import(/* @vite-ignore */ collisionPath),
      ])
      const session = (await createRemoteFrontierSession(collision, {
        apiUrl,
        getToken: () => Promise.resolve(token),
      })) as FrontierSession
      Reflect.set(globalThis, '__loadingObserver', session)
      const presence = setInterval(() => {
        if (
          !Reflect.get(globalThis, '__targetSeenAt') &&
          session.world.players.some((player) => player?.name === targetName)
        ) {
          Reflect.set(globalThis, '__targetSeenAt', Date.now())
        }
      }, 20)
      let seq = 0
      const timer = setInterval(
        () =>
          session.update(0.05, { seq: seq++, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }),
        50,
      )
      Reflect.set(globalThis, '__stopLoadingObserver', () => {
        clearInterval(timer)
        clearInterval(presence)
        session.dispose()
      })
      return session.lobbyId
    },
    { token: observerAccount.token, apiUrl: api, targetName: targetAccount.name },
  )
  const target = await browser.newPage({
    viewport: { width: 812, height: 375 },
    hasTouch: true,
    isMobile: true,
  })
  target.on('pageerror', (error) => errors.push(error.message))
  await target.addInitScript(() => {
    for (const [name, time] of [
      ['__nativeFrontierSession', '__joinedAt'],
      ['__playcanvasFrontier', '__inputReadyAt'],
    ]) {
      if (!(name && time)) {
        continue
      }
      let value: unknown
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get: () => value,
        set: (next: unknown) => {
          value = next
          Reflect.set(globalThis, time, Date.now())
        },
      })
    }
  })
  let joins = 0
  target.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/town/native/join') {
      joins++
    }
  })
  const townRequested = deferred()
  const townRelease = deferred()
  const gunRequested = deferred()
  const gunRelease = deferred()
  await target.route('**/3d/**/frontier.glb?*', async (route) => {
    townRequested.resolve()
    await townRelease.promise
    await route.continue().catch(() => undefined)
  })
  await target.route('**/equipment/gun.rusty-six.glb?*', async (route) => {
    gunRequested.resolve()
    await gunRelease.promise
    await route.continue().catch(() => undefined)
  })
  const url = new URL(`${origin}/experiments/out-west/frontier/`)
  url.search = new URLSearchParams({
    server: 'remote',
    api,
    token: targetAccount.token,
    ...(lobby ? { lobby } : {}),
  }).toString()
  await target.goto(url.href, { waitUntil: 'domcontentloaded' })
  for (const [stage, requested, release] of [
    ['map', townRequested, townRelease],
    ['own gun', gunRequested, gunRelease],
  ] as const) {
    await requested.promise
    await new Promise((resolve) => setTimeout(resolve, 3500))
    const state = {
      stage,
      joins,
      absent: await absent(observer, targetAccount.name),
      loading: await target.locator('.pc-travel').isVisible(),
    }
    observations.push(state)
    if (state.joins !== 0 || !state.absent || !state.loading) {
      throw new Error(`Download consumed a live player: ${JSON.stringify(state)}`)
    }
    await target.screenshot({ path: `${output}/${stage === 'map' ? 'map' : 'own-gun'}-held.png` })
    release.resolve()
  }
  await target.waitForFunction(() => Reflect.get(globalThis, '__playcanvasFrontier'), undefined, {
    timeout: 90_000,
  })
  const ready = await target.evaluate(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const own = session.world.players[session.selfSlot]
    if (!own) {
      throw new Error('Missing own rider')
    }
    return {
      joinedAt: Number(Reflect.get(globalThis, '__joinedAt')),
      inputReadyAt: Number(Reflect.get(globalThis, '__inputReadyAt')),
      controlsVisible: Boolean(
        document.querySelector<HTMLElement>('.pc-touch-controls') &&
          !document.querySelector<HTMLElement>('.pc-touch-controls')?.hidden &&
          !document.querySelector<HTMLElement>('.pc-touch-controls')?.inert,
      ),
      hp: own.hp,
      protectionRemaining: own.protectUntil - session.world.tick,
      tick: session.world.tick,
      loading: document.querySelector('.pc-game-root')?.classList.contains('pc-loading'),
    }
  })
  const presenceAt = await observer.evaluate(() =>
    Number(Reflect.get(globalThis, '__targetSeenAt')),
  )
  observations.push({
    stage: 'ready',
    joins,
    ...ready,
    nativeSessionToInputMs: ready.inputReadyAt - ready.joinedAt,
    observerPresenceToInputMs: presenceAt ? ready.inputReadyAt - presenceAt : null,
  })
  if (
    joins !== 1 ||
    ready.loading ||
    ready.hp !== 100 ||
    ready.protectionRemaining <= 0 ||
    !ready.controlsVisible
  ) {
    throw new Error(`Controls missed fresh spawn protection: ${JSON.stringify(ready)}`)
  }
  await observer.evaluate(() => Reflect.get(globalThis, '__stopLoadingObserver')())
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(JSON.stringify({ observations, errors }))
} finally {
  await writeFile(`${output}/measurements.json`, JSON.stringify({ observations, errors }, null, 2))
  await browser.close()
}
