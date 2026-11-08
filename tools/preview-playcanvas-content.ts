import { chromium } from 'playwright'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4388'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (error) => console.error(error))
  for (const name of ['frontier', 'duel', 'depot', 'mission', 'bank'] as const) {
    await page.goto(`${base}/404`)
    await page.evaluate(async (scene) => {
      const module = '/tools/content/preview-scene.ts'
      const { previewScene } = await import(/* @vite-ignore */ module)
      await previewScene(scene)
    }, name)
    await page.screenshot({ path: `/tmp/out-west-playcanvas-${name}.png` })
    console.log(`previewed ${name}`)
  }
} finally {
  await browser.close()
}
