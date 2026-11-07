/** Actual production Frontier kill, followed by a posed metal-feature pixel check. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { itemArtFingerprint } from './item-art.ts'

const SHADER_ERROR = /WebGL|Shader|GL_INVALID/u
const base = process.argv.find((value) => value.startsWith('http')) ?? 'http://127.0.0.1:4321'
const out = '.playwright-mcp/quality/badge'
mkdirSync(out, { recursive: true })
const hash = itemArtFingerprint()
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
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
  await page.goto(`${base}/#tier=high`)
  const killed = await page.evaluate(async () => {
    const path = '/tools/character-quality/death.ts'
    const death = (await import(
      /* @vite-ignore */ path
    )) as typeof import('./character-quality/death.ts')
    await death.prepareDeath(false, {
      outfit: 'outfit.shirt-vest',
      extra: 'extra.tin-star',
      weapon: 0,
    })
    return death.triggerDeath()
  })
  await page.waitForFunction(
    () => performance.now() - Number(Reflect.get(globalThis, '__qualityDeathAt')) >= 1800,
  )
  await page.locator('.fr-canvas').screenshot({ path: `${out}/real-kill-full.png` })
  const proof = await page.evaluate(async () => {
    const path = '/tools/character-quality/badge-death-proof.ts'
    const mod = (await import(
      /* @vite-ignore */ path
    )) as typeof import('./character-quality/badge-death-proof.ts')
    return mod.actualBadgeProof()
  })
  writeFileSync(
    `${out}/corpse-after-real-kill.png`,
    Buffer.from(proof.withBadge.split(',')[1] ?? '', 'base64'),
  )
  writeFileSync(
    `${out}/corpse-without-badge.png`,
    Buffer.from(proof.withoutBadge.split(',')[1] ?? '', 'base64'),
  )
  if (itemArtFingerprint() !== hash || errors.length > 0) {
    throw new Error(`Source/render failure:${errors.join(',')}`)
  }
  writeFileSync(
    `${out}/real-kill.json`,
    JSON.stringify(
      {
        artHash: hash,
        capturedAt: new Date().toISOString(),
        killed,
        changedPixels: proof.changedPixels,
        triangles: proof.triangles,
        state: proof.state,
        errors,
      },
      null,
      2,
    ),
  )
  console.log(
    `Actual kill corpse badge:${proof.changedPixels} changed pixels,${proof.triangles} triangles`,
  )
} finally {
  await browser.close()
}
