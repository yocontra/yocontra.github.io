// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: the server judges real reaction and reconnect timing
/** Two native browser clients using real authenticated matchmaking and DuelRoom settlement. */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const hmrSocketPattern = `${origin.replace(/^http/u, 'ws')}/**`
const api = process.env.OW_API ?? 'http://127.0.0.1:8792'
const evidence = process.env.OW_EVIDENCE ?? '/tmp/out-west-duel-pvp-evidence'
const phoneViewports = new Map([
  ['landscape', { width: 844, height: 390 }],
  ['portrait', { width: 390, height: 844 }],
])
const phone = phoneViewports.get(process.env.OW_SIZE ?? '')
const viewport = phone ?? { width: 1280, height: 800 }
const startupTimeout = Number(process.env.OW_STARTUP_TIMEOUT_MS ?? 90_000)
if (!Number.isFinite(startupTimeout) || startupTimeout <= 0) {
  throw new Error('OW_STARTUP_TIMEOUT_MS must be a positive timeout')
}
const captureInterval = Number(process.env.OW_CAPTURE_TICKS_PER_FRAME ?? 0)
if (!Number.isInteger(captureInterval) || captureInterval < 0) {
  throw new Error('OW_CAPTURE_TICKS_PER_FRAME must be a nonnegative integer')
}
const touch = phone !== undefined
await mkdir(evidence, { recursive: true })
const browser = process.env.OW_BROWSER_WS
  ? await chromium.connect(process.env.OW_BROWSER_WS)
  : await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const livePages: import('playwright').Page[] = []
async function loadPlayer() {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch })
  const page = await context.newPage()
  livePages.push(page)
  page.on('pageerror', (error) => errors.push(error.message))
  // Freeze only Vite's HMR channel; game WebSockets still connect to the real API.
  await page.routeWebSocket(hmrSocketPattern, () => undefined)
  const tier = phone ? '&tier=low' : ''
  await page.goto(`${origin}/experiments/out-west/#debug&level=1${tier}`, {
    waitUntil: 'domcontentloaded',
  })
  if (captureInterval > 0) {
    await page.waitForFunction(
      async (interval) => {
        const engine = performance
          .getEntriesByType('resource')
          .find(
            (entry) =>
              entry.name.includes('/.vite/') &&
              new URL(entry.name).pathname.endsWith('/playcanvas.js'),
          )
        if (!engine) {
          return false
        }
        const { AppBase } = (await import(engine.name)) as typeof import('playcanvas')
        const app = AppBase.getApplication()
        if (!app) {
          return false
        }
        // Keep the real input, simulation and networking clocks running between captured frames.
        app.autoRender = false
        let updates = 0
        app.on('update', () => {
          updates += 1
          if (updates % interval === 0) {
            app.renderNextFrame = true
          }
        })
        return true
      },
      captureInterval,
      { timeout: startupTimeout, polling: 100 },
    )
  }
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: startupTimeout,
  })
  await page.locator('.ow-start').click({ timeout: startupTimeout })
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__ow').director.phase === 'cock',
    null,
    { timeout: startupTimeout },
  )
  return page
}

try {
  const pages: import('playwright').Page[] = []
  if (process.env.OW_SERIAL_CLIENT_LOAD === '1') {
    const first = await loadPlayer()
    console.log('First player loaded')
    // Before matchmaking, an idle scene can yield its renderer to the second loader.
    await first.evaluate(() => {
      Reflect.get(globalThis, '__ow').director.game.app.autoRender = false
    })
    pages.push(first, await loadPlayer())
    await first.evaluate((enabled) => {
      Reflect.get(globalThis, '__ow').director.game.app.autoRender = enabled
    }, captureInterval === 0)
  } else {
    pages.push(...(await Promise.all([loadPlayer(), loadPlayer()])))
  }
  console.log('Pages ready')
  const seeds = await Promise.all(
    pages.map(async () => {
      const response = await fetch(`${api}/__test/seed`)
      if (!response.ok) {
        throw new Error(`Fixture seed: ${response.status}`)
      }
      return (await response.json()) as { token: string; name: string }
    }),
  )
  const matches = await Promise.all(
    pages.map((page, index) =>
      page.evaluate(
        async ({ apiOrigin, token }) => {
          const response = await fetch(`${apiOrigin}/queue/ticket`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
          })
          if (!response.ok) {
            throw new Error(`Queue ticket ${response.status}: ${await response.text()}`)
          }
          const ticket = await response.json()
          const match = await new Promise<{
            wsUrl: string
            matchId: string
            mode: string
            opponent: unknown
          }>((resolve, reject) => {
            const socket = new WebSocket(ticket.wsUrl)
            const timeout = setTimeout(() => {
              socket.close()
              reject(new Error('Matchmaking timed out'))
            }, 45_000)
            socket.addEventListener('message', (event) => {
              const message = JSON.parse(event.data)
              if (message.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong', n: message.n }))
              }
              if (message.type === 'matched') {
                clearTimeout(timeout)
                socket.close()
                resolve(message)
              }
              if (message.type === 'refused' || message.type === 'error') {
                clearTimeout(timeout)
                socket.close()
                reject(new Error(JSON.stringify(message)))
              }
            })
            socket.addEventListener('error', () => {
              clearTimeout(timeout)
              reject(new Error('Queue socket failed'))
            })
          })
          if (match.mode !== 'pvp') {
            throw new Error('Matchmaker returned a ghost instead of the second browser')
          }
          Reflect.get(globalThis, '__ow').startPvp({
            ...match,
            xpBefore: 0,
            purse: 0,
            refreshXp: async () => null,
            onExit: () => undefined,
          })
          return { matchId: match.matchId, mode: match.mode }
        },
        { apiOrigin: api, token: seeds[index]?.token ?? '' },
      ),
    ),
  )
  if (matches[0]?.matchId !== matches[1]?.matchId) {
    throw new Error('Browsers entered different rooms')
  }
  console.log('Matched', matches)
  const first = pages[0]
  const second = pages[1]
  if (!(first && second)) {
    throw new Error('Missing two browser pages')
  }
  await first.getByRole('button', { name: 'Ready', exact: true }).waitFor()
  await first.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'cock')
  console.log('Cock: pause confirmation')
  await first.keyboard.press('Escape')
  const leave = first.getByRole('alertdialog', { name: 'Leave the duel?' })
  await leave.waitFor()
  if (await first.locator('.ow-menu.on').count()) {
    throw new Error('Authoritative duel opened local restart menu')
  }
  await leave.getByRole('button', { name: 'Stay', exact: true }).click()
  await first.getByRole('button', { name: 'Ready', exact: true }).click()
  // A real page lifecycle transition must suspend the room socket and restore its accepted Ready.
  console.log('Ready accepted; background')
  await first.evaluate(() =>
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  )
  await first.waitForTimeout(300)
  await first.evaluate(() =>
    globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  )
  await first.waitForFunction(
    () => document.querySelector('.ow-match button:disabled')?.textContent === 'Ready ✓',
  )
  console.log('Resume ready; second ready')
  await second.getByRole('button', { name: 'Ready', exact: true }).click()
  await Promise.all(
    pages.map(async (page) => {
      await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'walk')
      await page.keyboard.down('w')
    }),
  )
  console.log('Walk started')
  const winner = pages[0]
  if (!winner) {
    throw new Error('Missing first browser')
  }
  await winner.waitForFunction(
    () => Reflect.get(globalThis, '__ow').director.phase === 'call',
    null,
    { timeout: 30_000 },
  )
  console.log('Called')
  await winner.waitForTimeout(220)
  await winner.keyboard.press('Space')
  await Promise.all(
    pages.map(async (page, index) => {
      await page.keyboard.up('w')
      await page.locator('.ow-results.on').waitFor({ timeout: 15_000 })
      await page.waitForFunction(() => {
        const panel = document.querySelector('.ow-results')
        const title = panel?.querySelector('.ow-results-title')
        return (
          panel &&
          getComputedStyle(panel).opacity === '1' &&
          title?.getAnimations().every((animation) => animation.playState === 'finished')
        )
      })
      const actionsStayVisible = await page.locator('.ow-results-panel').evaluate((panel) => {
        const details = panel.querySelector<HTMLElement>('.ow-results-details')
        const actions = panel.querySelector('.ow-results-actions')
        if (!(details && actions)) {
          return false
        }
        const panelBox = panel.getBoundingClientRect()
        const actionsBox = actions.getBoundingClientRect()
        const visible =
          actionsBox.height > 0 &&
          actionsBox.top >= panelBox.top &&
          actionsBox.bottom <= Math.min(panelBox.bottom, innerHeight)
        details.scrollTop = details.scrollHeight
        const stayedInPlace = actions.getBoundingClientRect().top === actionsBox.top
        details.scrollTop = 0
        return visible && stayedInPlace
      })
      if (!actionsStayVisible) {
        throw new Error(`Result actions leave the visible receipt on client ${index}`)
      }
      if (captureInterval > 0) {
        await page.evaluate(async () => {
          const app = Reflect.get(globalThis, '__ow').director.game.app
          const frame = new Promise<void>((resolve) => app.once('postrender', resolve))
          app.renderNextFrame = true
          await frame
        })
      }
      await page.screenshot({ path: `${evidence}/player-${index}-result.png` })
    }),
  )
  const result = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => ({
        phase: Reflect.get(globalThis, '__ow').director.phase,
        text: document.querySelector('.ow-results')?.textContent ?? '',
      })),
    ),
  )
  if (result[0]?.phase !== 'win' || result[1]?.phase !== 'lose') {
    throw new Error(`Wrong authoritative result: ${JSON.stringify(result)}`)
  }
  const receipt = await fetch(`${api}/duel/${matches[0]?.matchId}`, {
    headers: { Authorization: `Bearer ${seeds[0]?.token}` },
  }).then((response) => response.json())
  if (!receipt.settled || receipt.outcome !== 'win') {
    throw new Error(`Settlement not committed: ${JSON.stringify(receipt)}`)
  }
  console.log('Settled', receipt)
  await Promise.all(
    pages.map((page) => page.getByRole('button', { name: 'Rematch', exact: true }).click()),
  )
  await Promise.all(
    pages.map(async (page) => {
      await page.waitForFunction(
        () => Reflect.get(globalThis, '__ow').director.phase === 'walk',
        null,
        { timeout: 15_000 },
      )
      if (await page.locator('.ow-match.on').count()) {
        throw new Error('Rematch reopened a Ready intro instead of auto-readying')
      }
    }),
  )
  await Promise.all(pages.map((page) => page.keyboard.down('w')))
  await first.waitForFunction(
    () => Reflect.get(globalThis, '__ow').director.phase === 'wait',
    null,
    { timeout: 20_000 },
  )
  await first.keyboard.press('Space')
  await Promise.all(
    pages.map(async (page) => {
      await page.keyboard.up('w')
      await page.locator('.ow-results.on').waitFor({ timeout: 10_000 })
    }),
  )
  const early = await fetch(`${api}/duel/${matches[0]?.matchId}`, {
    headers: { Authorization: `Bearer ${seeds[0]?.token}` },
  }).then((response) => response.json())
  if (early.outcome !== 'coward' || !early.settled) {
    throw new Error(`Early draw was ignored: ${JSON.stringify(early)}`)
  }
  await Promise.all(
    pages.map((page) => page.getByRole('button', { name: 'Rematch', exact: true }).click()),
  )
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'walk', null, {
        timeout: 15_000,
      }),
    ),
  )
  await second.keyboard.press('Escape')
  await second.getByRole('alertdialog', { name: 'Leave the duel?' }).waitFor()
  await second.evaluate(() => Reflect.get(globalThis, '__ow').destroy())
  if (await second.getByRole('alertdialog').count()) {
    throw new Error('Destroy retained flee confirmation')
  }
  const escaped = await second.evaluate(() => {
    let reached = false
    const observe = () => {
      reached = true
    }
    globalThis.addEventListener('keydown', observe, { once: true })
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }))
    globalThis.removeEventListener('keydown', observe)
    return reached
  })
  if (!escaped) {
    throw new Error('Destroy retained confirmation Escape capture')
  }
  await first.keyboard.press('Escape')
  const rematchLeave = first.getByRole('alertdialog', { name: 'Leave the duel?' })
  await rematchLeave.getByRole('button', { name: 'Leave', exact: true }).click()
  let forfeit = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const latest = await fetch(`${api}/duel/${matches[0]?.matchId}`, {
      headers: { Authorization: `Bearer ${seeds[0]?.token}` },
    }).then((response) => response.json())
    if (latest.outcome === 'forfeit' && latest.settled) {
      forfeit = true
      break
    }
    await first.waitForTimeout(100)
  }
  if (!forfeit) {
    throw new Error('Confirmed flee did not settle as a forfeit')
  }
  await first.evaluate(async () => {
    const modulePath = '/src/experiments/out-west/content/manifest.ts'
    const { ASSETS } = await import(/* @vite-ignore */ modulePath)
    const d = Reflect.get(globalThis, '__ow').director
    const game = d.game
    const load = game.loadContainer.bind(game)
    const pending: { resolve: () => void }[] = []
    game.loadContainer = async (url: string) => {
      const asset = await load(url)
      if (url === ASSETS.player.url) {
        await new Promise<void>((resolve) => pending.push({ resolve }))
      }
      return asset
    }
    const waitFor = async (count: number) => {
      for (let i = 0; i < 1000 && pending.length < count; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      if (pending.length < count) {
        throw new Error('Concurrent actor load did not reach controlled boundary')
      }
    }
    try {
      const older = d.startLevel(15)
      await waitFor(1)
      const newer = d.startLevel(15)
      await waitFor(2)
      pending[1]?.resolve()
      await newer
      const current = d.rifleman
      pending[0]?.resolve()
      await older
      if (!current || d.rifleman !== current || !current.root.parent) {
        throw new Error('Stale underboss load replaced the current rifleman')
      }
    } finally {
      game.loadContainer = load
      for (const item of pending) {
        item.resolve()
      }
    }
  })
  await Promise.all(
    pages.map((page) => page.evaluate(() => Reflect.get(globalThis, '__ow').destroy())),
  )
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    JSON.stringify(
      {
        matches,
        result,
        receipt,
        lifecycle: [
          'flee-stay',
          'background-ready-rejoin',
          'auto-ready-rematch',
          'early-shot-penalty',
          'flee-forfeit',
          'destroy-open-confirmation',
        ],
        errors,
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(error)
  for (const [index, page] of livePages.entries()) {
    console.error('PAGE', index, await page.locator('body').textContent())
    console.error(
      await page.evaluate(() => {
        const d = Reflect.get(globalThis, '__ow')?.director
        return { phase: d?.phase, remote: d?.remote?.beat, closed: d?.remote?.closed, errors: [] }
      }),
    )
    await page
      .screenshot({ path: `${evidence}/failure-${index}.png` })
      .catch((reason: unknown) => console.error(reason))
  }
  throw error
} finally {
  await browser.close()
}
