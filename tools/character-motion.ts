/** Native production kill motion, actual gear pixels, chronological filmstrips and source hashes. */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import sharp, { type OverlayOptions } from 'sharp'
import {
  TOWN_WIRE_VERSION,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
} from '../src/experiments/out-west/contract/town.ts'
import type * as Death from './character-quality/death.ts'
import type { DeathOptions } from './character-quality/death.ts'
import type { corpseGearProof } from './character-quality/gear-proof.ts'
import { textureMeterScript } from './character-quality/memory.ts'
import { clearMotionOutput } from './character-quality/motion-output.ts'
import { itemArtFingerprint } from './item-art.ts'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4321'
const out = '.playwright-mcp/quality/physical-motion'
const SHADER_ERROR = /WebGL|Shader|GL_INVALID|program not valid/u
const width = 1280
const height = 800
interface Case {
  name: string
  tier: 'high' | 'floor'
  far: boolean
  setup: DeathOptions
  falling?: boolean
  gear?: boolean
}
const cases: Case[] = [
  {
    name: 'high-near-ground-poncho-rifle',
    tier: 'high',
    far: false,
    setup: { direction: 0 },
    gear: true,
  },
  {
    name: 'high-far-ground-frock-pair',
    tier: 'high',
    far: true,
    setup: { outfit: 'outfit.gamblers-frock', weapon: WEAPON_REVOLVER, direction: Math.PI },
    gear: true,
  },
  {
    name: 'floor-near-ground-frock-pair',
    tier: 'floor',
    far: false,
    setup: { outfit: 'outfit.gamblers-frock', weapon: WEAPON_REVOLVER, direction: Math.PI / 2 },
  },
  {
    name: 'floor-far-ground-poncho-rifle',
    tier: 'floor',
    far: true,
    setup: { direction: -Math.PI / 2 },
  },
  {
    name: 'high-near-roof-frock-pair',
    tier: 'high',
    far: false,
    setup: { roof: true, outfit: 'outfit.gamblers-frock', weapon: WEAPON_REVOLVER },
  },
  { name: 'floor-far-roof-poncho-rifle', tier: 'floor', far: true, setup: { roof: true } },
  {
    name: 'high-far-facade-poncho-rifle',
    tier: 'high',
    far: true,
    setup: { facade: true, direction: Math.PI / 2 },
  },
  {
    name: 'floor-near-hatless-poncho-rifle',
    tier: 'floor',
    far: false,
    setup: { hatless: true, direction: Math.PI },
  },
  {
    name: 'high-near-live-midfall',
    tier: 'high',
    far: false,
    setup: { weapon: WEAPON_RIFLE },
    falling: true,
  },
]
function fingerprint(): string {
  const hash = createHash('sha256').update(itemArtFingerprint())
  const files = [
    ...sourceFiles('src/experiments/out-west'),
    ...sourceFiles('api/src/town'),
    ...sourceFiles('tools/character-quality'),
    'tools/character-motion.ts',
  ].sort((left, right) => left.localeCompare(right))
  for (const file of files) {
    hash.update(file).update(readFileSync(file))
  }
  return hash.digest('hex')
}
function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    return entry.isFile() ? [path] : []
  })
}
const sourceHash = fingerprint()
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
mkdirSync(out, { recursive: true })
try {
  for (const test of cases) {
    const filter = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7)
    if (filter && !test.name.includes(filter)) {
      continue
    }
    await capture(test)
    if (fingerprint() !== sourceHash) {
      throw new Error('Motion source changed during capture; repeat current matrix')
    }
  }
} finally {
  await browser.close()
}

function moduleCall<T>(page: Page, method: keyof typeof Death): Promise<T> {
  return page.evaluate(async (name) => {
    const path = '/tools/character-quality/death.ts'
    const mod = (await import(/* @vite-ignore */ path)) as typeof Death
    return Reflect.apply(mod[name], undefined, [])
  }, method) as Promise<T>
}
async function capture(test: Case): Promise<void> {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.addInitScript({ content: textureMeterScript })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && SHADER_ERROR.test(message.text())) {
      errors.push(message.text())
    }
  })
  const dir = join(out, test.name)
  mkdirSync(dir, { recursive: true })
  clearMotionOutput(dir)
  try {
    await page.routeWebSocket(
      (url) => url.host === new URL(base).host,
      (socket) => socket.send(JSON.stringify({ type: 'connected' })),
    )
    await page.goto(`${base}/#tier=${test.tier}`)
    await page.evaluate(async ({ far, setup }) => {
      const path = '/tools/character-quality/death.ts'
      const mod = (await import(/* @vite-ignore */ path)) as typeof Death
      await mod.prepareDeath(far, setup)
    }, test)
    const before = await moduleCall(page, 'deathFrame')
    await page.locator('.fr-canvas').screenshot({ path: join(dir, 'alive.png') })
    await moduleCall(page, 'startDeathVideo')
    let killed: unknown
    if (test.falling || test.setup.roof) {
      killed = await realFall(page, Boolean(test.setup.roof))
    } else {
      killed = await moduleCall(page, 'triggerDeath')
    }
    const frames: { path: string; state: Record<string, unknown> }[] = []
    for (const ms of [0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1500, 2000, 3000, 4500]) {
      await page.waitForFunction(
        (minimum) =>
          performance.now() - Number(Reflect.get(globalThis, '__qualityDeathAt')) >= minimum,
        ms,
      )
      const state = await moduleCall<Record<string, unknown>>(page, 'deathFrame')
      const path = join(dir, `frame-${ms.toString().padStart(4, '0')}.png`)
      await page.locator('.fr-canvas').screenshot({ path })
      frames.push({ path, state })
    }
    const video = await moduleCall<{ url: string; frameTimes: number[]; mime: string }>(
      page,
      'stopDeathVideo',
    )
    writeFileSync(join(dir, 'motion.webm'), Buffer.from(video.url.split(',')[1] ?? '', 'base64'))
    let gear: unknown
    if (test.gear) {
      gear = await proveGear(page, dir)
    }
    await filmstrip(dir, frames)
    const metadata = {
      sourceMode: 'development-current-source',
      sourceHash,
      artHash: itemArtFingerprint(),
      wire: TOWN_WIRE_VERSION,
      capturedAt: new Date().toISOString(),
      base,
      test,
      before,
      killed,
      frames: frames.map(({ state }) => state),
      frameTimes: video.frameTimes,
      videoMime: video.mime,
      gear,
      errors,
    }
    writeFileSync(join(dir, 'motion.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    if (errors.length > 0) {
      throw new Error(errors.join('\n'))
    }
    console.log(`${test.name}: ${frames.length} frames, actual WebM + gear ${Boolean(test.gear)}`)
  } finally {
    await context.close()
  }
}
function realFall(page: Page, roof: boolean): Promise<unknown> {
  return page.evaluate(async (fromRoof) => {
    const path = '/tools/character-quality/death.ts'
    const mod = (await import(/* @vite-ignore */ path)) as typeof Death
    // No screenshots or host round trips consume the short genuine roof-falling window.
    await mod.startAuthoritativeFall(fromRoof)
    return mod.finishAuthoritativeFall(fromRoof ? -2 : -12.7)
  }, roof)
}
async function proveGear(page: Page, dir: string): Promise<unknown> {
  const result = await page.evaluate(async () => {
    const path = '/tools/character-quality/gear-proof.ts'
    const mod = (await import(/* @vite-ignore */ path)) as {
      corpseGearProof: typeof corpseGearProof
    }
    return mod.corpseGearProof()
  })
  for (const proof of result) {
    writeFileSync(
      join(dir, `gear-${proof.item}.png`),
      Buffer.from(proof.url.split(',')[1] ?? '', 'base64'),
    )
  }
  return result.map(({ item, pixels, draws }) => ({ item, pixels, draws }))
}
async function filmstrip(
  dir: string,
  frames: { path: string; state: Record<string, unknown> }[],
): Promise<void> {
  const cells: OverlayOptions[] = []
  const cropCells: OverlayOptions[] = []
  const w = 384
  const h = 264
  const cols = 4
  for (const [i, frame] of frames.entries()) {
    const left = (i % cols) * w
    const top = Math.floor(i / cols) * h
    const label = Buffer.from(
      `<svg width="384" height="24"><rect width="100%" height="100%" fill="#211c18"/><text x="8" y="17" fill="#f5e7ca" font-size="13">${Math.round(Number(frame.state.elapsedMs))}ms</text></svg>`,
    )
    cells.push(
      { input: await sharp(frame.path).resize(w, 240).png().toBuffer(), left, top },
      { input: label, left, top: top + 240 },
    )
    const crop = frame.state.crop as number[] | null
    let image = sharp(frame.path)
    if (crop) {
      const x = Math.max(0, Math.floor((((crop[0] ?? -1) + 1) * width) / 2))
      const y = Math.max(0, Math.floor(((1 - (crop[3] ?? 1)) * height) / 2))
      const right = Math.min(width, Math.ceil((((crop[2] ?? 1) + 1) * width) / 2))
      const bottom = Math.min(height, Math.ceil(((1 - (crop[1] ?? -1)) * height) / 2))
      if (right > x && bottom > y) {
        image = image.extract({ left: x, top: y, width: right - x, height: bottom - y })
      }
    }
    cropCells.push(
      {
        input: await image
          .resize(w, 240, { fit: 'contain', background: '#211c18' })
          .png()
          .toBuffer(),
        left,
        top,
      },
      { input: label, left, top: top + 240 },
    )
  }
  const create = {
    width: cols * w,
    height: Math.ceil(frames.length / cols) * h,
    channels: 3 as const,
    background: '#211c18',
  }
  await sharp({ create }).composite(cells).png().toFile(join(dir, 'filmstrip.png'))
  await sharp({ create }).composite(cropCells).png().toFile(join(dir, 'body-filmstrip.png'))
}
