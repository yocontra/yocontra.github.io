/** Actual native browser acceptance: all gear, finite dyes, leases and packed appearances. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { CATALOG } from '../src/experiments/out-west/data/catalog.ts'
import { DYES } from '../src/experiments/out-west/data/dye.ts'
import { textureMeterScript } from './character-quality/memory.ts'

const directory = resolve(
  process.env.OUT_WEST_CHARACTER_EVIDENCE ?? '/tmp/out-west-native-character-evidence',
)
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage({
    viewport: { width: 600, height: 800 },
    deviceScaleFactor: 1,
  })
  await page.routeWebSocket(
    (url) => url.origin === 'ws://127.0.0.1:4390',
    () => undefined,
  )
  await page.addInitScript({ content: textureMeterScript })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'}/404`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await page.evaluate(async () => {
    const path = '/tools/content/character-preview.ts'
    const preview = await import(path)
    await preview.previewCharacter()
  })
  if (!process.env.OUT_WEST_VISUALS_ONLY) {
    const lease = await page.evaluate(async () => {
      const path = '/tools/content/character-preview.ts'
      return (await import(path)).materialLifecycleProbe()
    })
    console.log('Material lifecycle', JSON.stringify(lease))
    const packed = await page.evaluate(async () => {
      const path = '/tools/content/character-preview.ts'
      const preview = await import(path)
      return {
        characters: await preview.packedCharacters(),
        gpu: Reflect.get(globalThis, '__owTextureStats')?.(),
      }
    })
    await page.screenshot({ path: resolve(directory, 'packed32.png') })
    console.log('Packed32', JSON.stringify(packed))
    await writeFile(resolve(directory, 'memory.json'), JSON.stringify({ lease, packed }, null, 2))
    const released = await page.evaluate(async () => {
      const path = '/tools/content/character-preview.ts'
      return (await import(path)).clearCharacters()
    })
    if (released.count !== 0) {
      throw new Error(`Packed models left ${released.count} GPU maps`)
    }
  }
  const items = CATALOG.filter((item) =>
    ['hat', 'outfit', 'gun', 'spurs', 'holster', 'extra'].includes(item.slot),
  )
  for (const item of items) {
    await page.evaluate(async ({ id, slot }) => {
      const path = '/tools/content/character-preview.ts'
      const preview = await import(path)
      await preview.previewCharacter(
        { [slot]: id },
        {},
        slot === 'gun' ? 'Idle_Gun_Pointing' : 'Idle',
        25,
      )
    }, item)
    await page.screenshot({ path: resolve(directory, `${item.id}.png`) })
    console.log('Visual', item.id)
  }
  const images = await Promise.all(
    items.map(async (item, index) => ({
      input: await sharp(resolve(directory, `${item.id}.png`))
        .resize(300, 400)
        .extend({ top: 30, bottom: 0, left: 0, right: 0, background: '#201b16' })
        .composite([
          {
            input: Buffer.from(
              `<svg width="300" height="30"><text x="10" y="21" fill="#ffffff" font-size="13">${item.id}</text></svg>`,
            ),
            top: 0,
            left: 0,
          },
        ])
        .toBuffer(),
      left: (index % 5) * 300,
      top: Math.floor(index / 5) * 430,
    })),
  )
  await sharp({
    create: {
      width: 1500,
      height: Math.ceil(items.length / 5) * 430,
      channels: 4,
      background: '#201b16',
    },
  })
    .composite(images)
    .png()
    .toFile(resolve(directory, 'all37-gear.png'))
  for (const dye of DYES) {
    await page.evaluate(async (id) => {
      const path = '/tools/content/character-preview.ts'
      const preview = await import(path)
      await preview.previewCharacter({}, { 'outfit.trail-duds': id }, 'Idle', 25)
    }, dye.id)
    await page.screenshot({ path: resolve(directory, `dye-${dye.id}.png`) })
  }
  await writeFile(resolve(directory, 'errors.json'), JSON.stringify(errors, null, 2))
  if (errors.length > 0) {
    throw new Error(`Browser errors: ${errors.join('; ')}`)
  }
  console.log(
    `PASS native character visual/lease harness: ${items.length} gear, ${DYES.length} dyes, packed32`,
  )
} finally {
  await browser.close()
}
