/** Real Chromium microphone permission/native audio; deterministic nonbillable SFU transport. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output = '/tmp/out-west-voice-proof'
const origin = 'http://127.0.0.1:4398'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  )
  await page.goto(`${origin}/tools/content/voice-fixture.html`)
  await page.setContent(
    `<style>body { margin: 24px; background: #2b2118; color: #efe4cc; font: 16px Georgia }</style>
     <h1>Proximity voice</h1>
     <p>Native microphone permission and standby</p>`,
  )
  const cdp = await page.context().newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  if (!targetInfo.browserContextId) {
    throw new Error('Missing isolated test browser context')
  }
  await cdp.send('Browser.setPermission', {
    browserContextId: targetInfo.browserContextId,
    permission: { name: 'microphone' },
    setting: 'denied',
    origin,
  })
  await page.evaluate(async () => {
    const path = '/tools/content/voice-lifecycle.ts'
    const probe = await import(path)
    Reflect.set(globalThis, '__voiceProbe', probe)
    probe.beginVoice()
  })
  const value = () => page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot())
  const state = (name: string) =>
    page
      .waitForFunction(
        (expected) => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().state === expected,
        name,
        { timeout: 5000 },
      )
      .catch(async (error) => {
        console.log(await value(), errors)
        throw error
      })
  await page.getByText('Microphone blocked.', { exact: false }).waitFor()
  const denied = await value()
  if (denied.requests !== 0) {
    throw new Error('Permission denial contacted voice provider')
  }
  await page.screenshot({ path: `${output}/microphone-blocked.png` })
  await cdp.send('Browser.setPermission', {
    browserContextId: targetInfo.browserContextId,
    permission: { name: 'microphone' },
    setting: 'granted',
    origin,
  })
  await page.getByRole('button', { name: 'Retry voice chat' }).press('Enter')
  await state('standby')
  const standby = await value()
  if (standby.requests !== 0 || standby.original !== 'live' || standby.originalEnabled) {
    throw new Error('Standby joined or failed local capture')
  }
  await page.screenshot({ path: `${output}/standby-no-listeners.png` })
  await page.keyboard.down('t')
  const alone = await value()
  if (alone.requests !== 0 || !alone.originalEnabled) {
    throw new Error('Alone PTT joined provider or failed intent')
  }
  await page.keyboard.up('t')
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').setAudience(1))
  if ((await value()).requests !== 0) {
    throw new Error('Listener arrival alone joined provider')
  }
  await page.keyboard.down('t')
  await state('live')
  const live = await value()
  if (!live.enabled || live.requests !== 1) {
    throw new Error('Speech plus listener did not join/transmit')
  }
  await page.keyboard.up('t')
  if ((await value()).enabled) {
    throw new Error('PTT release retained publication')
  }
  await state('standby')
  const silent = await value()
  if (silent.track !== 'ended' || silent.original !== 'live') {
    throw new Error('Idle teardown stopped original or retained clone')
  }
  await page.screenshot({ path: `${output}/standby-nearby-listener.png` })
  await page.keyboard.down('t')
  await state('live')
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').interrupt())
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().originalEnabled === false,
  )
  const interrupted = await value()
  if (
    interrupted.enabled ||
    interrupted.originalEnabled ||
    interrupted.commands.at(-1)?.talking !== false
  ) {
    throw new Error('Native context interruption retained intent')
  }
  await page.keyboard.up('t')
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').resume())
  await page.keyboard.down('t')
  await page.evaluate(() => dispatchEvent(new Event('blur')))
  if ((await value()).originalEnabled) {
    throw new Error('Blur retained capture publication')
  }
  await page.keyboard.up('t')
  await page.evaluate(() => dispatchEvent(new Event('focus')))
  const receive = await page.evaluate(() =>
    Reflect.get(globalThis, '__voiceProbe').nativeReceiveProof(),
  )
  if (
    !receive.borrowedContext ||
    receive.gain !== 0.25 ||
    receive.after.context !== 'running' ||
    receive.after.track !== 'live'
  ) {
    throw new Error('Native receive ownership/gain failed')
  }
  const vad = await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').nativeVadProof())
  if (vad.silent || !vad.speech || vad.interrupted || !vad.disposed) {
    throw new Error(`Native VAD failed ${JSON.stringify(vad)}`)
  }
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').setOpenMic())
  if (!(await value()).originalEnabled) {
    throw new Error('Open mic did not arm native capture')
  }
  await page.getByRole('button', { name: 'Mute microphone' }).click()
  if ((await value()).originalEnabled) {
    throw new Error('Open mic local mute failed')
  }
  await page.getByRole('button', { name: 'Unmute microphone' }).click()
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').setOpenMic(false))
  await page.keyboard.down('t')
  await state('live')
  await page.keyboard.up('t')
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').transport.disconnectVoice())
  await state('error')
  const disconnected = await value()
  if (disconnected.original !== 'ended' || disconnected.track !== 'ended') {
    throw new Error('Disconnect retained capture')
  }
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').disableService(true))
  await page.getByRole('button', { name: 'Retry voice chat' }).click()
  await page.getByText('Voice chat is disabled on this server.', { exact: false }).waitFor()
  await page.screenshot({ path: `${output}/server-disabled.png` })
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').disableService(false))
  await page.getByRole('button', { name: 'Retry voice chat' }).click()
  await state('standby')
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').transport.holdJoin(true))
  await page.keyboard.down('t')
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().joining === true,
  )
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').setVoiceEnabled(false))
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, '__voiceProbe')
    fixture.transport.finishJoin()
    fixture.transport.holdJoin(false)
  })
  await state('off')
  const cancelled = await value()
  if (
    cancelled.original !== 'ended' ||
    (cancelled.track !== undefined && cancelled.track !== 'ended')
  ) {
    throw new Error('Cancelled join leaked tracks')
  }
  await page.keyboard.up('t')
  await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').setVoiceEnabled(true))
  await state('standby')
  const disposed = await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').disposeVoice())
  if (
    disposed.controls !== 0 ||
    disposed.context !== 'closed' ||
    disposed.original !== 'ended' ||
    errors.length > 0
  ) {
    throw new Error(`Dispose failed ${JSON.stringify({ disposed, errors })}`)
  }
  const result = {
    denied,
    standby,
    alone,
    live,
    silent,
    interrupted,
    disconnected,
    cancelled,
    disposed,
    receive,
    vad,
    errors,
    realMicrophone: false,
    providerSessionCreated: false,
    transport: 'deterministic nonbillable fixture',
  }
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2))
  console.log('PASS native microphone permission, lazy voice controls, VAD and track lifecycle')
} finally {
  await browser.close()
}
