/** Actual fake-device Chromium capture, shared settings and nonbillable SDK producer changes. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import type * as Probe from './content/voice-lifecycle.ts'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
const root = new URL('../', import.meta.url)
const TRANSPORT = /out-west\/voice\/transport\.ts$/u
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-voice-input-proof'
const temporary = await mkdtemp(join(tmpdir(), 'out-west-voice-input-'))
await mkdir(output, { recursive: true })
const entry = join(temporary, 'fixture.ts')
await writeFile(
  entry,
  `import * as probe from ${JSON.stringify(new URL('tools/content/voice-lifecycle.ts', root).pathname)};
${['tokens', 'controls', 'sheets', 'features'].map((name) => `import ${JSON.stringify(new URL(`src/experiments/out-west/ui/${name}.css`, root).pathname)};`).join('\n')}
import ${JSON.stringify(new URL('src/experiments/out-west/ffa/client/shooter.css', root).pathname)};
globalThis.__voiceProbe=probe;`,
)
const build = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  outdir: temporary,
  external: ['/experiments/out-west/*'],
  plugins: [
    {
      name: 'nonbillable-voice-producer',
      setup(builder) {
        builder.onLoad({ filter: TRANSPORT }, async ({ path }) => ({
          contents: (await readFile(path, 'utf8')).replaceAll(
            "from './meeting.ts'",
            `from ${JSON.stringify(new URL('tools/content/voice-meeting-fixture.ts', root).pathname)}`,
          ),
          loader: 'ts',
          resolveDir: dirname(path),
        }))
      },
    },
  ],
})
if (!build.success) {
  throw new Error(build.logs.join('\n'))
}
const resources = new Map(build.outputs.map((artifact) => [basename(artifact.path), artifact]))
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/') {
      return new Response(
        [
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">',
          '<title>Voice input proof</title><link rel="stylesheet" href="/fixture.css">',
          '<style>body { margin: 0; background: #18110b; color: #efe4cc; padding: 20px; box-sizing: border-box }',
          '.fr-settings{max-width:480px;margin:auto;padding:16px}</style>',
          '<script type="module" src="/fixture.js"></script>',
        ].join('\n'),
        { headers: { 'content-type': 'text/html' } },
      )
    }
    const artifact = resources.get(path.slice(1))
    if (artifact) {
      return new Response(artifact)
    }
    return path.startsWith('/experiments/out-west/')
      ? new Response(Bun.file(new URL(`public${path}`, root)))
      : new Response('Not found', { status: 404 })
  },
})
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const errors: string[] = []
const external: string[] = []
async function setup(context: BrowserContext) {
  const page = await context.newPage()
  const navigations: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navigations.push(frame.url())
    }
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== server.url.origin) {
      external.push(route.request().url())
      return route.abort()
    }
    return route.continue()
  })
  await page.addInitScript(() => {
    const media = navigator.mediaDevices
    const nativeCapture = media.getUserMedia.bind(media)
    const nativeEnumerate = media.enumerateDevices.bind(media)
    const state = {
      requests: [] as MediaStreamConstraints[],
      tracks: [] as MediaStreamTrack[],
      held: false as boolean,
      release: [] as (() => void)[],
      missing: '',
      enumerations: 0,
      identity: crypto.randomUUID(),
    }
    Reflect.set(globalThis, '__captureProof', state)
    media.getUserMedia = async (constraints) => {
      state.requests.push(constraints ?? {})
      const stream = await nativeCapture(constraints)
      state.tracks.push(...stream.getTracks())
      if (state.held) {
        await new Promise<void>((resolve) => state.release.push(resolve))
      }
      return stream
    }
    media.enumerateDevices = async () => {
      state.enumerations++
      return (await nativeEnumerate()).filter((device) => device.deviceId !== state.missing)
    }
  })
  await page.goto(server.url.href)
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__voiceProbe')))
  const cdp = await context.newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  const browserContextId = targetInfo.browserContextId
  check(browserContextId, 'Missing isolated browser context')
  const permission = (setting: 'denied' | 'granted' | 'prompt') =>
    cdp.send('Browser.setPermission', {
      browserContextId,
      permission: { name: 'microphone' },
      setting,
      origin: server.url.origin,
    })
  const command = (method: keyof typeof Probe, ...values: unknown[]) =>
    page.evaluate(
      ({ name, args }) => {
        const probe = Reflect.get(globalThis, '__voiceProbe')
        return Reflect.apply(Reflect.get(probe, name), probe, args)
      },
      { name: method, args: values },
    )
  const snapshot = async () =>
    (await command('voiceSnapshot')) as ReturnType<typeof Probe.voiceSnapshot>
  return { page, navigations, permission, command, snapshot }
}
async function selected(page: Page, inputId: string, wantedState: 'live' | 'standby' = 'standby') {
  await page.waitForFunction(
    ({ device, state }) => {
      const value = Reflect.get(globalThis, '__voiceProbe').voiceSnapshot()
      return value.state === state && value.inputDevice === device && value.original === 'live'
    },
    { device: inputId, state: wantedState },
    { timeout: 5000 },
  )
}
const records: unknown[] = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  try {
    const f = await setup(context)
    const { page } = f
    await f.permission('denied')
    await f.command('showInputSettings', false)
    const input = page.getByLabel('Microphone', { exact: true })
    await input.waitFor()
    check(await input.isDisabled(), 'Picker enumerated before permission')
    check(
      (await page.evaluate(() => Reflect.get(globalThis, '__captureProof').requests.length)) === 0,
      'Opening settings captured audio',
    )
    await page.getByRole('button', { name: 'Choose microphone', exact: true }).click()
    await page.getByText('Microphone blocked.', { exact: false }).waitFor()
    await f.permission('granted')
    await page.getByRole('button', { name: 'Choose microphone', exact: true }).click()
    await page.waitForFunction(
      () => !document.querySelector<HTMLSelectElement>('.ow-voice-input select')?.disabled,
    )
    const devices = await input.locator('option').evaluateAll((options) =>
      options.map((option) => ({
        id: (option as HTMLOptionElement).value,
        label: option.textContent,
      })),
    )
    const physical = devices.filter((device) => device.id)
    check(physical.length >= 2, 'Chromium fixture lacks two native input devices')
    const a = physical[0]?.id ?? ''
    const b = physical[1]?.id ?? ''
    const offRequests = await page.evaluate(
      () => Reflect.get(globalThis, '__captureProof').requests.length,
    )
    await input.selectOption(b)
    check(
      (await page.evaluate(() => Reflect.get(globalThis, '__captureProof').requests.length)) ===
        offRequests,
      'Selecting while voice is off captured audio',
    )
    check(
      await page.evaluate(
        (id) =>
          localStorage.getItem('ow.voice.input.v1') === id &&
          !Object.entries(localStorage).some(
            ([key, value]) => key !== 'ow.voice.input.v1' && value.includes(id),
          ),
        b,
      ),
      'Input identifier escaped its local-only preference',
    )
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((animation) => animation.finished))
    })
    await page.screenshot({ path: join(output, 'desktop-shared-settings.png') })
    await f.command('showInputSettings', true)
    await page.waitForFunction(
      (expected) =>
        document.querySelector<HTMLSelectElement>('.ow-voice-input select')?.value === expected,
      b,
    )
    check((await input.inputValue()) === b, 'Frontier picker did not share the local choice')
    await input.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(output, 'desktop-frontier-settings.png') })
    await input.selectOption(a)
    await f.command('beginVoice')
    await selected(page, a)
    const standby = await f.snapshot()
    check(standby.requests === 0 && standby.captures === 0, 'Idle capture allocated an SDK meeting')
    await input.focus()
    await page.keyboard.press('t')
    check(
      !(await f.snapshot()).commands.some(
        (control) => control.type === 'voice_talk' && control.talking,
      ),
      'Typing in microphone select triggered PTT',
    )
    await input.selectOption(b)
    await selected(page, b)
    await f.permission('denied')
    await f.command('selectMicrophone', a)
    await page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().state === 'error',
    )
    check((await f.snapshot()).requests === 0, 'Permission denial allocated a meeting')
    await f.permission('granted')
    await page.getByRole('button', { name: 'Retry voice chat', exact: true }).press('Enter')
    await selected(page, a)
    await f.command('selectMicrophone', 'missing-fixture-input')
    await selected(page, 'default')
    check((await f.snapshot()).input === '', 'Missing input did not reset to system default')
    await f.command('selectMicrophone', a)
    await selected(page, a)
    await page.evaluate((missing) => {
      Reflect.get(globalThis, '__captureProof').missing = missing
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    }, a)
    await selected(page, 'default')
    await page.evaluate(() => {
      Reflect.get(globalThis, '__captureProof').missing = ''
    })
    await page.evaluate(() => {
      Reflect.get(globalThis, '__captureProof').held = true
    })
    await f.command('selectMicrophone', a)
    await page.waitForFunction(() => Reflect.get(globalThis, '__captureProof').release.length > 0)
    await f.command('selectMicrophone', b)
    await page.evaluate(() => {
      const s = Reflect.get(globalThis, '__captureProof')
      s.held = false
      for (const release of s.release.splice(0)) {
        release()
      }
    })
    await selected(page, b)
    check((await f.snapshot()).captures === 0, 'Changing idle devices allocated a producer')
    await f.command('showInputSettings', false)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await f.command('keepFixtureMeeting', true)
    await f.command('setAudience', 1)
    await page.keyboard.down('t')
    await selected(page, b, 'live')
    await page.keyboard.up('t')
    const joined = await f.snapshot()
    await f.command('selectMicrophone', a)
    await selected(page, a, 'live')
    const reused = await f.snapshot()
    check(
      reused.requests === joined.requests &&
        reused.leaves === joined.leaves &&
        reused.disables === joined.disables + 1,
      'Input switch replaced the meeting instead of its native producer',
    )
    check(
      reused.clones.slice(0, -1).every((track) => track.state === 'ended'),
      'Replaced SDK clone remained live',
    )
    await page.evaluate(() =>
      Reflect.get(globalThis, '__voiceProbe').transport.holdMicrophone(true, false),
    )
    await f.command('selectMicrophone', b)
    await page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().disabling,
    )
    await f.command('selectMicrophone', a)
    await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').transport.finishMicrophone())
    await selected(page, a, 'live')
    check(
      (await f.snapshot()).clones.slice(0, -1).every((track) => track.state === 'ended'),
      'Stale disable ended the latest producer incorrectly',
    )
    await page.evaluate(() =>
      Reflect.get(globalThis, '__voiceProbe').transport.holdMicrophone(false, true),
    )
    await f.command('selectMicrophone', b)
    await page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().enabling,
    )
    await f.command('selectMicrophone', a)
    await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').transport.finishMicrophone())
    await selected(page, a, 'live')
    const latest = await f.snapshot()
    check(
      latest.clones.at(-1)?.state === 'live' &&
        latest.clones.slice(0, -1).every((track) => track.state === 'ended'),
      'Stale enable cleanup stopped the current producer',
    )
    await page.evaluate(() =>
      Reflect.get(globalThis, '__voiceProbe').transport.holdMicrophone(false, true),
    )
    await f.command('selectMicrophone', b)
    await page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().enabling,
    )
    await f.command('disposeVoice')
    await page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').transport.finishMicrophone())
    await page.waitForFunction(() =>
      Reflect.get(globalThis, '__captureProof').tracks.every(
        (track: MediaStreamTrack) => track.readyState === 'ended',
      ),
    )
    check(
      (await f.snapshot()).clones.every((track) => track.state === 'ended'),
      'Close during SDK enable leaked a clone',
    )
    await page.evaluate(() => {
      Reflect.get(globalThis, '__captureProof').held = true
    })
    await f.command('beginVoice')
    await page.waitForFunction(() => Reflect.get(globalThis, '__captureProof').release.length > 0)
    await f.command('disposeVoice')
    await page.evaluate(() => {
      const s = Reflect.get(globalThis, '__captureProof')
      s.held = false
      for (const release of s.release.splice(0)) {
        release()
      }
    })
    await page.waitForFunction(() =>
      Reflect.get(globalThis, '__captureProof').tracks.every(
        (track: MediaStreamTrack) => track.readyState === 'ended',
      ),
    )
    await page.evaluate(async () => {
      const state = Reflect.get(globalThis, '__captureProof')
      const requests = state.requests.length
      const enumerations = state.enumerations
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
      Reflect.get(globalThis, '__voiceProbe').selectMicrophone('after-disposal')
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      if (requests !== state.requests.length || enumerations !== state.enumerations) {
        throw new Error('Disposed voice/settings retained microphone listeners')
      }
    })
    const final = await f.snapshot()
    check(
      final.clones.every((track) => track.state === 'ended') && final.requests === 1,
      'Late capture caused a new allocation or leaked a clone',
    )
    check(
      !(JSON.stringify(final.commands).includes(a) || JSON.stringify(final.commands).includes(b)),
      'Opaque input identifier entered game controls',
    )
    check(f.navigations.length === 1, 'Permission or microphone selection navigated the document')
    records.push({
      desktop: 'passed',
      devices: physical.map((device) => device.label),
      standbyAllocations: standby.requests,
      activeMeetingAllocations: final.requests,
      sdkClones: final.clones.length,
      allTracksEnded: true,
      navigations: f.navigations.length,
    })
  } finally {
    await context.close()
  }
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  try {
    const f = await setup(mobile)
    await f.permission('granted')
    await f.command('showInputSettings', false)
    await f.page.waitForFunction(
      () => !document.querySelector<HTMLSelectElement>('.ow-voice-input select')?.disabled,
    )
    await f.page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((animation) => animation.finished))
    })
    await f.page.screenshot({ path: join(output, 'mobile-shared-settings.png') })
    await f.command('showInputSettings', true)
    await f.page.getByLabel('Microphone', { exact: true }).scrollIntoViewIfNeeded()
    await f.page.screenshot({ path: join(output, 'mobile-frontier-settings.png') })
    check(
      (await f.page.evaluate(() => Reflect.get(globalThis, '__captureProof').requests.length)) ===
        0,
      'Mobile settings alone captured audio',
    )
    await f.command('showInputSettings', false)
    await f.page.getByRole('button', { name: 'Close', exact: true }).click()
    await f.page.locator('body').click({ position: { x: 5, y: 5 } })
    await f.command('beginVoice')
    await selected(f.page, 'default')
    await f.command('setAudience', 1)
    await f.page.keyboard.down('t')
    await selected(f.page, 'default', 'live')
    await f.page.keyboard.up('t')
    await f.page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().state === 'standby',
    )
    const idle = await f.snapshot()
    check(
      idle.original === 'live' && idle.clones.every((track) => track.state === 'ended'),
      'Default idle teardown stopped the source or retained its producer',
    )
    await f.command('disposeVoice')
    records.push({ mobile: 'passed', captureOnOpen: 0, defaultIdleTeardown: true })
    const leave = await f.command('deferredLeaveProof')
    await writeFile(join(output, 'deferred-leave.json'), `${JSON.stringify(leave, null, 2)}\n`)
    check(
      JSON.stringify(leave) ===
        JSON.stringify([
          { mode: 'dispose', state: 'off', lateStates: [], track: 'ended' },
          { mode: 'replace', state: 'live', lateStates: [], track: 'live' },
          { mode: 'current', state: 'error', lateStates: ['error'], track: 'ended' },
        ]),
      `Deferred room leave lifecycle failed: ${JSON.stringify(leave)}`,
    )
  } finally {
    await mobile.close()
  }
  check(
    errors.length === 0 && external.length === 0,
    `Browser/provider errors: ${JSON.stringify({ errors, external })}`,
  )
  await writeFile(
    join(output, 'result.json'),
    `${JSON.stringify({ records, errors, external }, null, 2)}\n`,
  )
  console.log(JSON.stringify({ records, output }))
} finally {
  await browser.close()
  await server.stop(true)
  await rm(temporary, { recursive: true, force: true })
}
