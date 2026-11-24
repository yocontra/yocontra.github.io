/**
 * Run against a local dev server, on the revision to compare.
 * bun tools/reference/record-out-west.ts URL EVIDENCE_DIR low|high campaign|noon|dusk|night|roof|round|bar [WIDTHxHEIGHT]
 * Set OW_CAPTURE_TICKS_PER_FRAME to render every N native simulation ticks on a software GPU.
 * Use the same setting on both revisions. The default captures every rendered frame.
 * OW_BROWSER_WS selects a remote Playwright browser. Each run needs its own output directory.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import type { NativeDirector } from '../../src/experiments/out-west/duel/native-director.ts'
import { configureRenderTicks, photographBar } from './frontier-camera.ts'
import { captureRoundReturn } from './round-return.ts'
import { captureSaloonRoute, prepareRouteAudio } from './saloon-route.ts'

const [origin, output, tier, group, size = '812x375'] = process.argv.slice(2)
if (
  !(
    origin &&
    output &&
    (tier === 'low' || tier === 'high') &&
    ['campaign', 'noon', 'dusk', 'night', 'roof', 'round', 'bar'].includes(group ?? '')
  )
) {
  throw new Error(
    'Expected URL EVIDENCE_DIR low|high campaign|noon|dusk|night|roof|round|bar [WIDTHxHEIGHT]',
  )
}
const [width, height] = size.split('x').map(Number)
if (
  !(
    width &&
    height &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0
  )
) {
  throw new Error('Expected a positive viewport such as 1280x720')
}
const ticksPerFrame = Number(process.env.OW_CAPTURE_TICKS_PER_FRAME ?? 0)
if (!Number.isInteger(ticksPerFrame) || ticksPerFrame < 0) {
  throw new Error('Expected nonnegative integer OW_CAPTURE_TICKS_PER_FRAME')
}
await mkdir(output)
const browser = process.env.OW_BROWSER_WS
  ? await chromium.connect(process.env.OW_BROWSER_WS)
  : await chromium.launch({ channel: 'chrome' })
const touch = process.env.OW_CAPTURE_TOUCH === '1'
const page = await browser.newPage({
  viewport: { width, height },
  serviceWorkers: 'block',
  isMobile: touch,
  hasTouch: touch,
})
page.setDefaultTimeout(900_000)
const errors: string[] = []
const assets = new Set<string>()
page.on('pageerror', (e) => errors.push(e.message))
page.on('response', (r) => {
  const url = new URL(r.url())
  if (r.ok() && url.pathname.endsWith('.glb')) {
    assets.add(url.pathname + url.search)
  }
  if (
    r.status() >= 400 &&
    (url.pathname.startsWith('/experiments/out-west/3d/') ||
      url.pathname.startsWith('/experiments/out-west/audio/'))
  ) {
    errors.push(`Asset returned ${r.status()}: ${url.pathname}`)
  }
})
const localHost = new URL(origin).host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
await page.route(new RegExp(`^https?://(?!${localHost}(?:/|$))`, 'u'), (route) => route.abort())
await page.routeWebSocket('**/*', (socket) => socket.close())
await page.addInitScript((value) => {
  // A return to Saloon navigates to a fresh document.
  if (location.pathname.startsWith('/experiments/out-west/') && !location.hash.includes('tier=')) {
    const url = new URL(location.href)
    const settings = new URLSearchParams(url.hash.slice(1))
    settings.set('tier', value)
    url.hash = settings.toString()
    history.replaceState(history.state, '', url)
  }
}, tier)
const samples: object[] = []
let completed = false
try {
  if (group === 'bar') {
    await page.goto(
      `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=29,38#tier=${tier}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')))
    if (ticksPerFrame) {
      await page.evaluate(configureRenderTicks, ticksPerFrame)
    }
    await photographBar(page, output)
    samples.push({
      name: 'bar-reference',
      day: 0.3,
      viewport: [812, 375],
      eye: [28.1, 1.55, 38.4],
      target: [25.6, 1.1, 36.95],
    })
  } else if (group === 'round') {
    await page.goto(
      `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7#tier=${tier}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')))
    if (ticksPerFrame) {
      await page.evaluate(configureRenderTicks, ticksPerFrame)
    }
    await captureRoundReturn(page, output, samples)
  } else if (group === 'campaign') {
    await campaign(page, { origin, tier, out: output }, samples)
  } else {
    await page.addInitScript(prepareRouteAudio)
    await captureSaloonRoute(
      page,
      {
        origin,
        tier,
        day: group === 'dusk' ? 0.75 : Number(group === 'night'),
        roof: group === 'roof',
        out: output,
        ticksPerFrame,
      },
      samples,
    )
  }
  if (group === 'night') {
    await captureRoundReturn(page, output, samples)
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  completed = true
} catch (error) {
  errors.push(String(error))
  throw error
} finally {
  await writeFile(
    join(output, 'capture.json'),
    JSON.stringify(
      {
        origin,
        tier,
        group,
        viewport: { width, height },
        ticksPerFrame,
        touch,
        completed,
        samples,
        assets: [...assets].sort((a, b) => a.localeCompare(b)),
        errors,
      },
      null,
      2,
    ),
  )
  await browser.close()
}

async function campaign(
  target: Page,
  options: { origin: string; tier: string; out: string },
  receipts: object[],
) {
  const out = options.out
  await target.goto(`${options.origin}/experiments/out-west/#tier=${options.tier}`, {
    waitUntil: 'domcontentloaded',
  })
  await target.evaluate(async () => {
    const path = '/src/experiments/out-west/duel/native-director.ts'
    const { NativeDirector: Director } = (await import(
      path
    )) as typeof import('../../src/experiments/out-west/duel/native-director.ts')
    const update = Director.prototype.update
    Director.prototype.update = function (dt) {
      Director.prototype.update = update
      Reflect.set(globalThis, '__referenceDirector', this)
      update.call(this, dt)
    }
  })
  await target.locator('.ow-title.ready').waitFor()
  await target.waitForFunction(() => Boolean(Reflect.get(globalThis, '__referenceDirector')))
  await target.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' })
  // A software renderer can take longer to read back a frame than a whole standoff.
  // Hold the campaign clock between shots and submit exactly the chosen native camera pose.
  await target.evaluate(() => {
    const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
    d.game.app.off('update', d.tick)
    d.game.app.autoRender = false
  })
  const frame = async (name: string, phase: NativeDirector['phase'], cameraSeconds = 0) => {
    const pose = await target.evaluate(
      async (sample) => {
        const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
        if (d.phase !== sample.phase) {
          throw new Error(`Expected ${sample.phase}, reached ${d.phase}`)
        }
        // The hub positions its lens directly from the panel layout. The title and duels use the rig.
        if (d.phase === 'title' && sample.cameraSeconds > 0) {
          d.update(0)
        } else {
          d.rig.update(sample.cameraSeconds)
        }
        const rendered = new Promise<void>((resolve) => d.game.app.once('postrender', resolve))
        d.game.app.renderNextFrame = true
        await rendered
        return {
          phase: d.phase,
          level: d.level,
          arena: d.arenas.id,
          camera: d.game.camera.getPosition().toArray(),
          tier: d.game.tier,
        }
      },
      { phase, cameraSeconds },
    )
    await target.screenshot({ path: join(out, `${name}.jpg`) })
    receipts.push({ name, ...pose })
    console.info(`${name} captured`)
  }
  // These shots use the real title crane, advanced to repeatable positions.
  for (const offset of [0, 10, 5]) {
    await target.evaluate((dt) => {
      const director = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
      if (!dt) {
        director.hubShot('title')
      }
      director.rig.update(dt)
    }, offset)
    await frame(`title-${offset}`, 'title')
  }
  await target.locator('.ow-start').click()
  await target.locator('.ow-tile-store').waitFor()
  await frame('saloon-rider-front', 'title', 0.8)
  await target.locator('.ow-tile-store').click()
  await target.getByRole('dialog', { name: 'The Outfitter' }).waitFor()
  const piece = target.locator('.ow-store-list .ow-item').nth(1)
  await piece.click()
  await target.locator('.ow-store-list .ow-item.picked').waitFor()
  await frame('outfitter-front', 'title', 0.8)
  await target.locator('.ow-store-turntable').press('ArrowRight')
  await frame('outfitter-quarter', 'title', 0.8)
  await target
    .getByRole('dialog', { name: 'The Outfitter' })
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click()
  await frame('saloon-rider-return', 'title', 0.8)
  await target.locator('.ow-hub').evaluate((h) => {
    h.classList.remove('on')
  })
  for (const slot of [0, 6, 10, 13]) {
    const arena = await target.evaluate(async (index) => {
      const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
      await d.startLevel(index)
      if (d.loadFailed || !d.enemy) {
        throw new Error('Duel actor load failed')
      }
      return d.arenas.id
    }, slot)
    await frame(`${arena}-introduction`, 'poster', 0.8)
    await target.evaluate(() => {
      const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
      d.remotePace(6)
      d.wait()
    })
    await frame(`${arena}-standoff`, 'wait', 0.8)
  }
  await target.evaluate(async () => {
    const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
    await d.startLevel(16)
    d.remotePace(6)
    d.wait()
    d.call()
    d.resolve('win', 200)
    // Keep the standoff lens for the wound and reach the native hit reaction after hitstop.
    for (let step = 0; step < 24; step++) {
      d.lastFrame = 0
      d.update(1 / 60)
    }
  })
  await frame('quick-draw-finale-wounded', 'bossWound', 0.8)
  await target.evaluate(() => {
    const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
    d.wait()
    d.call()
    d.resolve('win', 200)
    for (let step = 0; step < 600 && !d.m.cardShown; step++) {
      // Repeated steps share a compositor timestamp. Use the native first-frame dt path.
      d.lastFrame = 0
      d.update(1 / 60)
    }
    if (!d.m.cardShown) {
      throw new Error('Finale result card did not appear')
    }
  })
  await target.waitForFunction(() => {
    const card = document.querySelector('.ow-card.on')
    return card && getComputedStyle(card).opacity === '1'
  })
  await frame('quick-draw-finale-result', 'win', 0.8)
  // Exercise the real Daily presentation with a local protocol handshake. No online run is created.
  await target.routeWebSocket('**/reference-daily', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', sessionId: 'reference-daily', economyVersion: 1 }))
  })
  await target.evaluate(async () => {
    const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
    d.saloon()
    const modulePath = '/src/experiments/out-west/net/ranked.ts'
    const { RankedSession } = (await import(
      modulePath
    )) as typeof import('../../src/experiments/out-west/net/ranked.ts')
    const ws = new URL('/reference-daily', location.href)
    ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const result = await RankedSession.attach({
      sessionId: 'reference-daily',
      wsUrl: ws.href,
      resumeToken: '',
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    await d.dailyDuel({ outlaw: 0, modifiers: ['fog', 'no-bell'] }, result.value, () => d.saloon())
    document.querySelector('.ow-hub')?.classList.remove('on')
  })
  await frame('offline-daily-fog', 'poster', 0.8)
  await target.evaluate(() => {
    const d = Reflect.get(globalThis, '__referenceDirector') as NativeDirector
    d.leaveSpecial()
  })
  await frame('offline-daily-return', 'title', 0.8)
}
