/** Delay real KTX fetches, destroy the production application, and observe native GPU cleanup. */
import { mkdir, writeFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { chromium } from 'playwright'
import { textureMeterScript } from './character-quality/memory.ts'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'
const evidence = '/tmp/out-west-character-lifecycle'
await mkdir(evidence, { recursive: true })
const doc = await new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .read('public/experiments/out-west/3d/native-v2/equipment/outfit.trail-duds.glb')
const descriptor = doc
  .getRoot()
  .listMaterials()
  .find((material) => material.getName() === 'Dyeable')
  ?.getExtras().nativePbr as { dyes?: Record<string, string> } | undefined
const dye = descriptor?.dyes?.sage
if (!dye) {
  throw new Error('Missing source dye map')
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results: unknown[] = []
try {
  for (const phase of ['shared', 'dye', 'prepare'] as const) {
    const page = await browser.newPage({ viewport: { width: 600, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript({ content: textureMeterScript })
    await page.routeWebSocket(
      (url) => url.origin === 'ws://127.0.0.1:4390',
      () => undefined,
    )
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let seen: () => void = () => undefined
    const requested = new Promise<void>((resolve) => {
      seen = resolve
    })
    await page.route('**/native-v2/characters/**', async (route) => {
      if (phase === 'dye' && !route.request().url().endsWith(dye)) {
        await route.continue()
        return
      }
      seen()
      await held
      await route.continue().catch(() => undefined)
    })
    await page.goto(`${origin}/404`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(async (prepare) => {
      const path = '/tools/content/character-lifecycle.ts'
      await (await import(path)).beginInterruptedCharacter(prepare)
    }, phase === 'prepare')
    await Promise.race([
      requested,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`No delayed ${phase} request`)), 45_000),
      ),
    ])
    await page.evaluate(async () => {
      const path = '/tools/content/character-lifecycle.ts'
      ;(await import(path)).interruptCharacter()
    })
    release()
    const result = await page.evaluate(async () => {
      const path = '/tools/content/character-lifecycle.ts'
      return {
        result: await (await import(path)).interruptedCharacterResult(),
        gpu: Reflect.get(globalThis, '__owTextureStats')?.(),
      }
    })
    // biome-ignore lint/suspicious/noPlaywrightNetworkidle: this fixture drains deliberately aborted texture requests to detect late GPU resurrection.
    await page.waitForLoadState('networkidle')
    result.gpu = await page.evaluate(() => Reflect.get(globalThis, '__owTextureStats')?.())
    if (!result.result.cancelled || errors.length > 0 || result.gpu.bytes !== 0) {
      throw new Error(`${phase} leaked or resurrected: ${JSON.stringify({ result, errors })}`)
    }
    results.push({ phase, ...result, errors })
    await page.close()
  }
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2))
  console.log('PASS late shared/dye/KTX/preparation disposal', JSON.stringify(results))
} finally {
  await browser.close()
}
