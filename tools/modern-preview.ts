/** Refresh the modern game's preview from an actual local duel; the classic thumbnail is archival. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import sharp from 'sharp'
import type { Game } from '../src/experiments/out-west/game.ts'
import { itemArtFingerprint } from './item-art.ts'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4321'
const out = '.playwright-mcp/quality'
const target = 'public/experiments/out-west/thumb3d.webp'
const SHADER_ERROR = /WebGL|Shader|GL_INVALID|program not valid/u
const sourceHash = itemArtFingerprint()
mkdirSync(out, { recursive: true })
if (existsSync(target) && !existsSync(`${out}/modern-preview-before.webp`)) {
  copyFileSync(target, `${out}/modern-preview-before.webp`)
}
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && SHADER_ERROR.test(message.text())) {
      errors.push(message.text())
    }
  })
  await page.routeWebSocket(
    (url) => url.host === new URL(base).host,
    (socket) => socket.send(JSON.stringify({ type: 'connected' })),
  )
  await page.goto(`${base}/experiments/out-west/#level=7&debug&tier=high`)
  await page.locator('.ow-title.ready').waitFor({ timeout: 180_000 })
  await page.locator('.ow-start').click()
  await page.waitForFunction(
    () => {
      const game = Reflect.get(globalThis, '__ow') as Game | undefined
      return game && ['poster', 'cock', 'walk'].includes(game.director.phase)
    },
    null,
    { timeout: 180_000 },
  )
  await page.mouse.click(800, 500)
  await page.waitForFunction(
    () => (Reflect.get(globalThis, '__ow') as Game).director.phase === 'walk',
    null,
    { timeout: 30_000 },
  )
  await page.mouse.move(800, 500)
  await page.mouse.down()
  await page.waitForFunction(
    () => ['turn', 'wait'].includes((Reflect.get(globalThis, '__ow') as Game).director.phase),
    null,
    { timeout: 45_000 },
  )
  await page.mouse.up()
  await page.waitForFunction(
    () =>
      (Reflect.get(globalThis, '__ow') as Game).director.phase === 'wait' &&
      (Reflect.get(globalThis, '__ow') as Game).director.phaseT > 0.65,
    null,
    { timeout: 30_000 },
  )
  const state = await page.evaluate(() => {
    const game = Reflect.get(globalThis, '__ow') as Game
    game.director.paused = true
    return { phase: game.director.phase, opponent: game.director.outlaw.name }
  })
  await page.addStyleTag({
    content: '#ow > :not(.ow-canvas), astro-dev-toolbar { visibility: hidden !important; }',
  })
  const image = await page.locator('.ow-canvas').screenshot()
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  if (itemArtFingerprint() !== sourceHash) {
    throw new Error('Character art changed during the game preview capture')
  }
  writeFileSync(`${out}/modern-duel-preview.png`, image)
  await sharp(image).webp({ quality: 90 }).toFile(target)
  writeFileSync(
    `${out}/modern-preview.json`,
    `${JSON.stringify({ ...state, sourceHash, capturedAt: new Date().toISOString(), base }, null, 2)}\n`,
  )
  console.log(`Refreshed ${target} from ${state.phase}: ${state.opponent}`)
} finally {
  await browser.close()
}
