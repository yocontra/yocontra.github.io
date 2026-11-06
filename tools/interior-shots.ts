// biome-ignore-all lint/suspicious/noConsole: a CLI audit reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: the pages are captured one after another
/**
 * Interior / exterior visual pass for Perdition. Every building is spawned into through the dev
 * `?spawn=` hook, captured in third person, and (optionally) stitched into a contact sheet.
 *
 *   bun tools/interior-shots.ts http://localhost:4378 --out=.playwright-mcp/interiors
 *
 * The images are a review aid, not a rendered build artifact: the tool never ships.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4378'
const outArg = process.argv.find((a) => a.startsWith('--out='))
const out = outArg?.slice('--out='.length) ?? '.playwright-mcp/interiors'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e)))

async function shot(name: string, x: number, z: number, view: 'first' | 'third' | 'top') {
  await page.goto(`${base}/experiments/out-west/frontier/?debug&bots=0&spawn=${x},${z}`, {
    waitUntil: 'domcontentloaded',
  })
  // Wait for the dev harness, not a wall-clock guess: the game publishes `__frontierView` once
  // the round is up (ffa/client/index.ts).
  await page.waitForFunction(() => Reflect.has(globalThis, '__frontierView'), undefined, {
    timeout: 30_000,
  })
  await page
    .getByRole('button', { name: 'Skip' })
    .click({ timeout: 5000 })
    .catch(() => undefined)
  // Drive the view and wait in frames, so the camera's ease has run however fast the machine is.
  await page.evaluate(
    async ({ view: v, frames }) => {
      const hook = Reflect.get(globalThis, '__frontierView') as
        | { set: (view: 'first' | 'third' | 'top') => void }
        | undefined
      hook?.set(v)
      for (let i = 0; i < frames; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
    },
    { view, frames: 30 },
  )
  const path = join(out, `${name}.png`)
  await page.screenshot({ path })
  return path
}

const images: string[] = []
// A standard street view first, so the contact sheet has an exterior reference.
images.push(await shot('00-exterior', 72, 69, 'third'))
for (const b of TOWN.buildings) {
  const cx = Math.round((b.x + b.w / 2) * 2) / 2
  const cz = Math.round((b.z + b.d / 2) * 2) / 2
  images.push(await shot(b.id, cx, cz, b.hollow ? 'third' : 'third'))
  console.log(`captured ${b.id}`)
}

// Contact sheet: three columns, 640×400 tiles, labelled by a top strip.
const THUMB_W = 640
const THUMB_H = 400
const COLS = 3
const rows = Math.ceil(images.length / COLS)
const tiles = await Promise.all(
  images.map(async (path, i) => {
    const buf = await sharp(path).resize(THUMB_W, THUMB_H, { fit: 'cover' }).png().toBuffer()
    const label = Buffer.from(
      `<svg width="${THUMB_W}" height="28"><rect width="100%" height="100%" fill="#1b120c" opacity="0.85"/><text x="10" y="20" font-family="monospace" font-size="16" fill="#f0d9a8">${path.split('/').pop()}</text></svg>`,
    )
    return {
      input: await sharp(buf)
        .composite([{ input: label, top: 0, left: 0 }])
        .png()
        .toBuffer(),
      left: (i % COLS) * THUMB_W,
      top: Math.floor(i / COLS) * THUMB_H,
    }
  }),
)
await sharp({
  create: {
    width: COLS * THUMB_W,
    height: rows * THUMB_H,
    channels: 3,
    background: '#0e0a08',
  },
})
  .composite(tiles)
  .png()
  .toFile(join(out, 'contact-sheet.png'))

await browser.close()
console.log(`\n${images.length} shots in ${out}; errors: ${errors.length}`)
if (errors.length > 0) {
  console.log(errors.slice(0, 10))
}
