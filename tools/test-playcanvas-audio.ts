/** Real AudioContext/native SoundSlot overlap, blocked playback, trusted resume and disposal. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4397'
const output = '/tmp/out-west-native-audio'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket(`${origin.replace(/^http/u, 'ws')}/**`, (socket) => socket.close())
  await page.goto(`${origin}/404`, { waitUntil: 'domcontentloaded' })
  const blocked = await page.evaluate(async () => {
    const path = '/tools/content/audio-lifecycle.ts'
    const fixture = await import(path)
    Reflect.set(globalThis, '__nativeAudioProbe', fixture)
    return fixture.beginAudioLifecycle()
  })
  if (
    blocked.baselineVoices !== 200 ||
    blocked.fixed.state !== 'suspended' ||
    blocked.fixed.manuallySuspended ||
    blocked.fixed.voices !== 0 ||
    blocked.fixed.components !== 0 ||
    blocked.fixed.backend !== 'null'
  ) {
    throw new Error(`Native blocked-audio regression: ${JSON.stringify(blocked)}`)
  }
  // Keyboard deliberately tests our trusted-input hook, not native click/touch unlock listeners.
  await page.keyboard.press('a')
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__nativeAudioProbe').audioSnapshot().state === 'running',
  )
  const running = await page.evaluate(async () => {
    const path = '/tools/content/audio-lifecycle.ts'
    return (await import(path)).runningAudioShots()
  })
  if (running.voices !== 4 || running.components !== 1) {
    throw new Error(`Running overlap changed: ${JSON.stringify(running)}`)
  }
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__nativeAudioProbe').audioSnapshot().voices === 0,
  )
  const manual = await page.evaluate(async () => {
    const path = '/tools/content/audio-lifecycle.ts'
    return (await import(path)).manuallySuspendAudio()
  })
  if (!manual.manuallySuspended || manual.state !== 'suspended' || manual.voices !== 0) {
    throw new Error(`Manual suspension changed: ${JSON.stringify(manual)}`)
  }
  await page.keyboard.press('b')
  const stillManual = await page.evaluate(async () => {
    const path = '/tools/content/audio-lifecycle.ts'
    return (await import(path)).audioSnapshot()
  })
  if (!stillManual.manuallySuspended || stillManual.state !== 'suspended') {
    throw new Error(`Trusted input overrode manual suspension: ${JSON.stringify(stillManual)}`)
  }
  await page.evaluate(async () => {
    const path = '/tools/content/audio-lifecycle.ts'
    ;(await import(path)).explicitlyResumeAudio()
  })
  await page.waitForFunction(() => {
    const value = Reflect.get(globalThis, '__nativeAudioProbe').audioSnapshot()
    return value.state === 'running' && !value.manuallySuspended && value.voices === 0
  })
  const disposed = await page.evaluate(async () => {
    const path = '/tools/content/audio-lifecycle.ts'
    return (await import(path)).disposeAudioLifecycle()
  })
  await page.keyboard.press('c')
  if (disposed.context !== 'closed' || disposed.remainingSounds !== 0 || errors.length > 0) {
    throw new Error(`Audio disposal failed: ${JSON.stringify({ disposed, errors })}`)
  }
  const result = { blocked, running, manual, stillManual, disposed, errors }
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2))
  console.log('PASS native audio lifecycle', JSON.stringify(result))
} finally {
  await browser.close()
}
