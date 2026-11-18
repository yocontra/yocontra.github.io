import type { Browser, BrowserContext, Page } from 'playwright'
import type * as Probe from './voice-lifecycle.ts'

interface Fixture {
  page: Page
  permission: (setting: 'denied' | 'granted' | 'prompt') => Promise<unknown>
  command: (method: keyof typeof Probe, ...values: unknown[]) => Promise<unknown>
  snapshot: () => Promise<ReturnType<typeof Probe.voiceSnapshot>>
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
export async function receiveOnlyProof(
  browser: Browser,
  setup: (context: BrowserContext) => Promise<Fixture>,
) {
  const listeningContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  try {
    const f = await setup(listeningContext)
    const state = (value: string) =>
      f.page.waitForFunction(
        (expected) => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().state === expected,
        value,
        { timeout: 5000 },
      )
    await f.permission('denied')
    await f.command('beginVoice')
    await state('listening')
    const denied = await f.snapshot()
    check(
      denied.requests === 0 && denied.captures === 0,
      'Denied microphone allocated an idle provider meeting',
    )
    check(
      denied.commands.some((control) => control.type === 'voice_on'),
      'Denied microphone lost listener interest',
    )
    await f.command('inviteListener')
    await f.page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().connected,
    )
    await f.command('startFixtureSpeaker')
    await f.page.waitForFunction(() => {
      const s = Reflect.get(globalThis, '__voiceProbe').voiceSnapshot()
      return s.receiveNodes === 1 && s.receiveGain > 0
    })
    const receiving = await f.snapshot()
    check(
      receiving.state === 'listening' && receiving.captures === 0,
      'Receive-only join published a microphone',
    )
    await f.page.getByRole('button', { name: 'Retry microphone', exact: true }).waitFor()
    await f.command('deafen', true)
    await f.page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().receiveGain === 0,
    )
    await f.command('deafen', false)
    await f.page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().receiveGain > 0,
    )
    await f.permission('granted')
    await f.page.getByRole('button', { name: 'Retry microphone', exact: true }).click()
    await state('live')
    await f.page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().track === 'live',
    )
    const upgraded = await f.snapshot()
    check(
      upgraded.requests === 1 && upgraded.leaves === 0 && upgraded.receiveNodes === 1,
      'Microphone recovery interrupted the receiver or replaced its meeting',
    )
    await f.permission('denied')
    await f.command('endMicrophone')
    await state('listening')
    const ended = await f.snapshot()
    check(
      ended.connected && ended.receiveNodes === 1 && ended.requests === 1 && ended.leaves === 0,
      'Ended microphone disconnected nearby speech',
    )
    await f.page.evaluate(() => {
      Reflect.get(globalThis, '__captureProof').failure = 'NotFoundError'
    })
    await f.page.getByRole('button', { name: 'Retry microphone', exact: true }).click()
    await state('listening')
    await f.page.getByText('No microphone found.', { exact: false }).waitFor()
    check((await f.snapshot()).receiveNodes === 1, 'Missing microphone removed remote audio')
    await f.page.evaluate(() => {
      Reflect.get(globalThis, '__captureProof').failure = ''
    })
    await f.command('link', false)
    await f.command('link', true)
    await state('listening')
    await f.command('inviteListener')
    await f.page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().connected,
    )
    check(
      (await f.snapshot()).captures === upgraded.captures,
      'Receive reconnect published a failed microphone',
    )
    await f.permission('granted')
    await f.page.evaluate(() => {
      Reflect.get(globalThis, '__captureProof').held = true
    })
    await f.page.getByRole('button', { name: 'Retry microphone', exact: true }).click()
    await f.page.waitForFunction(() => Reflect.get(globalThis, '__captureProof').release.length > 0)
    await f.page.evaluate(() => Reflect.get(globalThis, '__voiceProbe').transport.holdJoin(true))
    await f.command('link', false)
    await f.command('link', true)
    await f.command('inviteListener')
    await f.page.waitForFunction(
      () => Reflect.get(globalThis, '__voiceProbe').voiceSnapshot().joining,
    )
    await f.page.evaluate(() => {
      const s = Reflect.get(globalThis, '__captureProof')
      s.held = false
      for (const release of s.release.splice(0)) {
        release()
      }
    })
    await f.page.evaluate(() => new Promise(requestAnimationFrame))
    await f.command('setVoiceEnabled', false)
    await f.page.waitForFunction(() =>
      Reflect.get(globalThis, '__captureProof').tracks.every(
        (track: MediaStreamTrack) => track.readyState === 'ended',
      ),
    )
    await f.page.evaluate(() => {
      const transport = Reflect.get(globalThis, '__voiceProbe').transport
      transport.finishJoin()
      transport.holdJoin(false)
    })
    await state('off')
    await f.command('disposeVoice')
    const final = await f.snapshot()
    check(
      final.receiveNodes === 0 && final.outputs.every((track) => track.state === 'ended'),
      'Receive-only disposal leaked audio nodes or microphone outputs',
    )
    return {
      receiveOnly: 'passed',
      idleAllocations: denied.requests,
      noMicrophonePublisher: receiving.captures,
      recoveredWithoutReconnect: true,
      endedMicrophoneRetainsReceive: true,
      missingMicrophoneRetainsReceive: true,
      deafen: true,
      reconnect: true,
      cancelledPendingJoinReleasesCapture: true,
    }
  } finally {
    await listeningContext.close()
  }
}
