/** Real game-page character texture residency across all seventeen authored encounters. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { Game } from '../src/experiments/out-west/game.ts'
import { textureMeterScript } from './character-quality/memory.ts'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'
const output = '/tmp/out-west-character-campaign-final'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket(
    (url) => url.origin === 'ws://127.0.0.1:4390',
    () => undefined,
  )
  await page.addInitScript({ content: textureMeterScript })
  await page.goto(`${origin}/experiments/out-west/#debug&level=1`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), undefined, {
    timeout: 90_000,
  })
  await page.locator('.ow-start').click()
  const samples: unknown[] = []
  for (const slot of [...Array.from({ length: 17 }, (_, index) => index), 0]) {
    const sample = await page.evaluate(async (index) => {
      const game = Reflect.get(globalThis, '__ow') as Game
      await game.director.startLevel(index)
      game.director.clock.cancel()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      const app = game.director.game.app
      const maps = app.assets
        .filter(
          (asset) =>
            asset.type === 'texture' &&
            Boolean(asset.resource) &&
            String((asset.file as { url?: string } | null)?.url).includes('/native-v2/characters/'),
        )
        .map((asset) => {
          const texture = asset.resource as import('playcanvas').Texture
          return {
            url: (asset.file as { url?: string } | null)?.url,
            bytes: texture.gpuSize,
            width: texture.width,
            height: texture.height,
            format: texture.format,
          }
        })
      const enemy = game.director.enemy
      if (!enemy) {
        throw new Error('Missing native outlaw')
      }
      for (const name of ['Head', 'WristR', 'FootL']) {
        if (enemy.root.find((node) => node.name === name).length !== 1) {
          throw new Error(`Ambiguous encounter${index}bone${name}`)
        }
      }
      return {
        slot: index,
        characterBytes: maps.reduce((sum, map) => sum + map.bytes, 0),
        maps,
        textureVram: app.stats.vram.tex,
        drawCalls: { ...app.stats.drawCalls },
        meter: Reflect.get(globalThis, '__owTextureStats')?.(),
      }
    }, slot)
    samples.push(sample)
    await page.screenshot({ path: `${output}/encounter-${slot}.png` })
  }
  if (errors.length > 0) {
    throw new Error(errors.join(';'))
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ samples, errors }, null, 2))
  console.log(
    'PASS all17 real-page character encounters',
    JSON.stringify(
      samples.map((sample) => {
        const s = sample as { slot: number; characterBytes: number; textureVram: number }
        return { slot: s.slot, characterBytes: s.characterBytes, textureVram: s.textureVram }
      }),
    ),
  )
} finally {
  await browser.close()
}
