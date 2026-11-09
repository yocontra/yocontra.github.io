/** Native clock/footplant evidence, independent of browser refresh rate. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { nativeCharacterTiming } from './content/character-timing.ts'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'
const output = process.env.OUT_WEST_EVIDENCE ?? '/tmp/out-west-character-timing'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/404`, { waitUntil: 'domcontentloaded' })
  const result = (await page.evaluate(async () => {
    const fixture = Reflect.get(globalThis, '__nativeTimingProbe')
    if (typeof fixture === 'function') {
      return fixture()
    }
    const path = '/tools/content/character-timing.ts'
    return (await import(path)).nativeCharacterTiming()
  })) as Awaited<ReturnType<typeof nativeCharacterTiming>>
  for (const gait of result.gaits) {
    if (
      Math.abs(gait.nativeTime - gait.rate * gait.wallSeconds) > 0.0001 ||
      gait.slip.contacts < 5 ||
      gait.slip.medianAbsolute > gait.speed * 0.08 + 0.02
    ) {
      throw new Error(`Unstable native gait/footplant: ${JSON.stringify(gait)}`)
    }
  }
  for (const shot of result.shots) {
    if (shot.duration <= 0 || Math.abs(shot.nativeTime - shot.duration) > 0.0001) {
      throw new Error(`Recoil did not complete in ${shot.seconds}s: ${JSON.stringify(shot)}`)
    }
    for (const mechanism of shot.mechanisms) {
      if (mechanism.duration <= 0 || Math.abs(mechanism.nativeTime - mechanism.duration) > 0.0001) {
        throw new Error(`Revolver mechanism clock disagrees: ${JSON.stringify(mechanism)}`)
      }
    }
  }
  for (const cue of result.cues) {
    if (Math.abs(cue.nativeTime - Math.min(cue.duration, 0.1)) > 0.0001) {
      throw new Error(`Nonhuman cue rate changed: ${JSON.stringify(cue)}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
  await writeFile(`${output}/result.json`, JSON.stringify({ ...result, errors }, null, 2))
  console.log('PASS native30/60/100Hz gait clocks, planted toes and complete200ms recoil')
} finally {
  await browser.close()
}
