import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import type { prepareDeath, triggerDeath } from './character-quality/death.ts'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4321'
const tier = process.argv.includes('--tier=floor') ? 'floor' : 'high'
const far = process.argv.includes('--far')
const label = process.argv.includes('--after') ? `after-${tier}-${far ? 'far' : 'near'}` : 'before'
const out = '.playwright-mcp/quality'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket(
    (url) => url.host === new URL(base).host,
    (socket) => socket.send(JSON.stringify({ type: 'connected' })),
  )
  await page.goto(`${base}/#tier=${tier}`)
  await page.evaluate(async (forceFar) => {
    const path = '/tools/character-quality/death.ts'
    const mod = (await import(/* @vite-ignore */ path)) as { prepareDeath: typeof prepareDeath }
    await mod.prepareDeath(forceFar)
  }, far)
  await page.waitForFunction(() => performance.now() > 3000)
  await page.locator('.fr-canvas').screenshot({ path: `${out}/death-${label}-alive.png` })
  const result = await page.evaluate(async () => {
    const path = '/tools/character-quality/death.ts'
    const mod = (await import(/* @vite-ignore */ path)) as { triggerDeath: typeof triggerDeath }
    return mod.triggerDeath()
  })
  await page.waitForFunction(
    () => performance.now() - Number(Reflect.get(globalThis, '__qualityDeathAt')) > 700,
  )
  await page.locator('.fr-canvas').screenshot({ path: `${out}/death-${label}-fallen.png` })
  await page.waitForFunction(
    () => performance.now() - Number(Reflect.get(globalThis, '__qualityDeathAt')) > 1600,
  )
  await page.locator('.fr-canvas').screenshot({ path: `${out}/death-${label}-settled.png` })
  writeFileSync(`${out}/death-${label}.json`, `${JSON.stringify({ result, errors }, null, 2)}\n`)
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(`Death evidence: ${out}/death-${label}-*.png`)
} finally {
  await browser.close()
}
