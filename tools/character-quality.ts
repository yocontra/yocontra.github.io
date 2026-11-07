/** Render reproducible contact sheets for the complete character and outfit presentation set. */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp, { type OverlayOptions } from 'sharp'
import { textureMeterScript } from './character-quality/memory.ts'
import type { captureCharacters } from './character-quality/probe.ts'
import { fileHash, itemArtFingerprint } from './item-art.ts'

const SHADER_ERROR = /WebGL|Shader|GL_INVALID|program not valid/u
const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4321'
const closeupsOnly = process.argv.includes('--closeups-only')
const artOnly = closeupsOnly || process.argv.includes('--art-only')
let out = '.playwright-mcp/quality'
if (artOnly) {
  out += '/character-fitting'
} else if (process.argv.includes('--diagnostic')) {
  out += '/character-diagnostic'
}
const escapeXml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

async function sheet(group: string, images: { name: string; path: string }[]): Promise<void> {
  if (images.length === 0) {
    return
  }
  const columns = 6
  const width = 240
  const height = 340
  const rows = Math.ceil(images.length / columns)
  const cells: OverlayOptions[] = []
  for (const [i, image] of images.entries()) {
    const x = (i % columns) * width
    const y = Math.floor(i / columns) * height
    const rendered = await sharp(image.path)
      .resize(width, height - 42, { fit: 'contain', background: '#3e3329' })
      .png()
      .toBuffer()
    const label = Buffer.from(
      `<svg width="${width}" height="42"><rect width="100%" height="100%" fill="#211c18"/><text x="8" y="17" fill="#f5e7ca" font-size="10" font-family="sans-serif">${escapeXml(image.name.slice(0, 34))}</text><text x="8" y="32" fill="#cbbb9b" font-size="10" font-family="sans-serif">${escapeXml(image.name.slice(34, 68))}</text></svg>`,
    )
    cells.push(
      { input: rendered, left: x, top: y },
      { input: label, left: x, top: y + height - 42 },
    )
  }
  await sharp({
    create: { width: columns * width, height: rows * height, channels: 3, background: '#211c18' },
  })
    .composite(cells)
    .png()
    .toFile(join(out, `${group}-sheet.png`))
}

const sourceHash = itemArtFingerprint()
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await context.addInitScript({ content: textureMeterScript })
  const page = await context.newPage()
  await page.routeWebSocket(
    (url) => url.host === new URL(base).host,
    (socket) => socket.send(JSON.stringify({ type: 'connected' })),
  )
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && SHADER_ERROR.test(message.text())) {
      errors.push(message.text())
    }
  })
  await page.goto(
    `${base}/experiments/out-west/frontier/?bots=0&seed=7&spawn=72,69#perf&tier=floor`,
  )
  await page.waitForFunction(() => Reflect.get(globalThis, '__crowd') !== undefined, null, {
    timeout: 120_000,
  })
  await page.locator('.fr-load').waitFor({ state: 'detached', timeout: 120_000 })
  const result = (await page.evaluate(
    async ({ onlyArt, onlyCloseups }) => {
      const url = '/tools/character-quality/probe.ts'
      const studio = (await import(
        /* @vite-ignore */ url
      )) as typeof import('./character-quality/probe.ts')
      return studio.captureCharacters(onlyArt, onlyCloseups)
    },
    { onlyArt: artOnly, onlyCloseups: closeupsOnly },
  )) as Awaited<ReturnType<typeof captureCharacters>>
  if (itemArtFingerprint() !== sourceHash) {
    throw new Error('Character source changed during capture; rerun the full gallery')
  }
  writeFileSync(
    join(out, 'character-source.json'),
    `${JSON.stringify(
      {
        sourceHash,
        capturedAt: new Date().toISOString(),
        base,
        artOnly,
        models: result.models.map((model) => ({
          ...model,
          sha256: fileHash(`public/experiments/out-west/3d/models/${model.base}.glb`),
        })),
      },
      null,
      2,
    )}\n`,
  )
  if (errors.length > 0) {
    throw new Error(`Character rendering failed: ${errors.join('\n')}`)
  }
  const groups = new Map<string, { name: string; path: string }[]>()
  for (const capture of result.captures) {
    const directory = join(out, capture.group)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${capture.name.replaceAll(/[^a-zA-Z0-9.-]/gu, '-')}.png`)
    writeFileSync(path, Buffer.from(capture.url.split(',')[1] ?? '', 'base64'))
    const group = groups.get(capture.group) ?? []
    group.push({ name: capture.name, path })
    groups.set(capture.group, group)
  }
  writeFileSync(join(out, 'character-gpu.json'), `${JSON.stringify(result.gpu, null, 2)}\n`)
  writeFileSync(join(out, 'character-cache.json'), `${JSON.stringify(result.cache, null, 2)}\n`)
  writeFileSync(join(out, 'character-fit.json'), `${JSON.stringify(result.fit, null, 2)}\n`)
  for (const [group, images] of groups) {
    await sheet(group, images)
    console.log(`${group}: ${images.length} images`)
  }
  for (const [name, dir] of [
    ['thumbs-before', '.playwright-mcp/quality/thumbs-before'],
    ['thumbs-after', 'public/experiments/out-west/thumbs'],
  ] as const) {
    await sheet(
      name,
      readdirSync(dir)
        .filter((file) => file.endsWith('.webp'))
        .sort()
        .map((file) => ({ name: file.replace('.webp', ''), path: join(dir, file) })),
    )
  }
  console.log(`Character evidence: ${out}`)
  if (!artOnly && result.gpu.farBodyPixels < 2000) {
    throw new Error(`Far body visibility failed: ${result.gpu.farBodyPixels}`)
  }
} finally {
  await browser.close()
}
