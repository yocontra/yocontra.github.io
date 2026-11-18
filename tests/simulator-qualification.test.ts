import { expect, test as it, spyOn } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { NativePost } from '../src/experiments/out-west/client/post.ts'
import {
  installQARecorderPrivacy,
  type QARecorderPrivacySample,
} from '../tools/content/frame-recorder.ts'
import { recordingAcknowledged, simulatorHost } from '../tools/content/simulator-host.ts'
import {
  commandPlan,
  frameForAX,
  hidTapArguments,
  nativeSafari,
  parseIDBApps,
  preflightIssues,
  preflightURL,
  targetForPreflight,
  webFrame,
} from '../tools/record-simulator-frames.ts'

const hostUI = /Simulator\.app|DeviceHub|osascript|focus|activate|cursor/u
const device = '59616A95-4749-4F6F-8E1D-1FAEA0263EFC'
const url = 'http://127.0.0.1:4398/experiments/out-west/frontier/?server=remote'
const application = { AXRole: 'AXApplication', bundleIdentifier: 'com.apple.mobilesafari', pid: 72 }
function evidence() {
  return {
    beforeAX: application,
    afterAX: application,
    expectedURL: url,
    receipt: {
      preflight: true,
      recording: {
        completed: true,
        inputs: [{ type: 'pointerdown' }],
        timestamps: Array.from({ length: 60 }, (_, index) => index * 34),
        samples: [
          {
            url,
            visible: 'visible',
            focused: true,
            privacy: {
              captureBlocked: true,
              voiceChatForcedOff: true,
              captureCalls: 0,
              graphics: {
                original: null,
                originalSettingsState: 'absent',
                applied: 'auto' as const,
                tierOverride: null,
                tierOverrideRaw: null,
              },
            },
            game: { scene: { renderer: { tier: 'low' as const, nativePost: null } } },
            audio: [{ state: 'running' }],
            contexts: [{ lost: false, buffer: { width: 812, height: 375 } }],
          },
        ],
      },
    },
  }
}
it('imports without simulator side effects and plans only guest/headless lifecycle commands', () => {
  const plan = commandPlan(device, preflightURL('http://localhost:4398', 'fixture'), 10_892)
  expect(plan.companion).toEqual([
    'idb_companion',
    '--udid',
    device,
    '--grpc-port',
    '10892',
    '--headless',
    '1',
  ])
  expect(plan.readyTimeoutMs).toBe(180_000)
  expect(plan.open.slice(0, 4)).toEqual(['xcrun', 'simctl', 'openurl', device])
  expect(JSON.stringify(plan)).not.toMatch(hostUI)
  expect(() => commandPlan('booted', url, 10_892)).toThrow()
  expect(() => commandPlan(device, url, 80)).toThrow()
  expect(() => preflightURL('https://example.com', 'id')).toThrow()
  // biome-ignore lint/security/noSecrets: deliberately invalid synthetic credential URL
  expect(() => preflightURL('http://name:secret@localhost', 'id')).toThrow()
})
it('refuses existing or unrelated simulator sessions', () => {
  const target = {
    udid: device,
    state: 'Shutdown',
    name: 'Out West QA iPhone 13 mini',
    isAvailable: true,
    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini',
  }
  const list = (value: typeof target) => ({ devices: { iOS: [value] } })
  const other = { ...target, udid: '30ECA787-F1B6-4540-9455-EF9F87BEC3F4' }
  const mixed = { devices: { iOS: [target, { ...other, name: 'Personal phone' }] } }
  const ambiguous = { devices: { iOS: [target, other] } }
  expect(targetForPreflight(mixed)).toEqual(target)
  expect(() => targetForPreflight(ambiguous)).toThrow('--udid')
  expect(targetForPreflight(ambiguous, device)).toEqual(target)
  expect(() => targetForPreflight(mixed, other.udid)).toThrow()
  for (const altered of [
    { ...target, state: 'Booted' },
    { ...target, name: 'Personal phone' },
    { ...target, isAvailable: false },
    { ...target, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' },
    { ...target, deviceTypeIdentifier: '' },
  ]) {
    expect(() => targetForPreflight(list(altered), device)).toThrow()
    expect(() => targetForPreflight(list(altered))).toThrow()
  }
  expect(() => targetForPreflight({}, device)).toThrow()
})
it('requires native guest identity and supported AX frames rather than RUNNING or page labels', () => {
  expect(nativeSafari(application)).toEqual({ bundle: 'com.apple.mobilesafari', pid: 72 })
  expect(
    nativeSafari({
      bundleIdentifier: 'com.apple.mobilesafari',
      state: 'RUNNING',
      AXLabel: 'Safari',
    }),
  ).toBeUndefined()
  expect(nativeSafari({ ...application, pid: 0 })).toBeUndefined()
  const frame = { x: 2, y: 10, width: 100, height: 60 }
  expect(frameForAX([{ AXLabel: 'Start', frame }], 'Start')).toEqual(frame)
  expect(webFrame({ AXRole: 'AXWebArea', AXFrame: frame })).toEqual(frame)
  expect(frameForAX({ AXLabel: 'Start', frame: '{{2,10},{100,60}}' }, 'Start')).toBeUndefined()
  expect(webFrame({ role: 'WebArea', frame: { ...frame, width: 0 } })).toBeUndefined()
})
it('requires complete guest capability evidence without certifying performance', () => {
  expect(preflightIssues(evidence())).toEqual([])
  const value = evidence()
  value.afterAX = { ...application, pid: 73 }
  value.receipt.recording.samples[0]?.audio.splice(0)
  value.receipt.recording.inputs.splice(0)
  const issues = preflightIssues(value)
  expect(issues).toContain('Native guest foreground Safari identity unavailable or changed')
  expect(issues).toContain('Guest game audio not running')
  expect(issues).toContain('Trusted guest HID pointer input missing')
})
it('rejects hidden or stale pages, lost graphics, short traces and capture attempts', () => {
  const value = evidence()
  const sample = value.receipt.recording.samples[0]
  if (!sample) {
    throw new Error('Missing fixture sample')
  }
  sample.url = 'http://localhost/old'
  sample.visible = 'hidden'
  sample.contexts[0] = { lost: true, buffer: { width: 0, height: 0 } }
  sample.privacy.captureCalls = 1
  value.receipt.recording.timestamps.splice(20)
  const issues = preflightIssues(value)
  expect(issues).toContain('Guest page URL/visibility/focus not established')
  expect(issues).toContain('Guest native graphics capability missing')
  expect(issues).toContain('Two-second native frame capability not established')
  expect(issues).toContain('Capture prevention missing or microphone capture attempted')
})
function privacyFixture(original: string | null, backup?: string, hash = '') {
  const storage = new Map<string, string>()
  if (original !== null) {
    storage.set('ow.settings.v1', original)
  }
  if (backup) {
    // biome-ignore lint/security/noSecrets: fixed localStorage key, not a credential
    storage.set('__owQaSettingsBackup', backup)
  }
  let nativeCalls = 0
  const handlers = new Map<string, () => void>()
  const context = {
    navigator: {
      mediaDevices: {
        getUserMedia: () => {
          nativeCalls++
          return Promise.resolve({})
        },
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: (event: string, action: () => void) => handlers.set(event, action),
    DOMException,
    URLSearchParams,
    location: { hash },
  }
  runInNewContext(`(${installQARecorderPrivacy.toString()})()`, context)
  const guard = Reflect.get(context, '__owQaPrivacy') as {
    inspect: () => QARecorderPrivacySample
    restoreSettings: () => void
  }
  return { context, storage, handlers, guard, nativeCalls: () => nativeCalls }
}
it('blocks microphone and temporarily selects auto graphics while preserving exact restoration', async () => {
  const original = '{"voiceChat":true,"graphics":"high","musicVolume":0.25,"effectsVolume":0.7}'
  const value = privacyFixture(original)
  expect(JSON.parse(value.storage.get('ow.settings.v1') ?? '{}')).toEqual({
    voiceChat: false,
    musicVolume: 0.25,
    effectsVolume: 0.7,
    graphics: 'auto',
  })
  await expect(value.context.navigator.mediaDevices.getUserMedia()).rejects.toThrow(
    'Microphone capture disabled',
  )
  expect(value.nativeCalls()).toBe(0)
  expect(value.guard.inspect()).toEqual({
    captureCalls: 1,
    captureBlocked: true,
    voiceChatForcedOff: true,
    graphics: {
      original: 'high',
      originalSettingsState: 'object',
      applied: 'auto',
      tierOverride: null,
      tierOverrideRaw: null,
    },
  })
  value.guard.restoreSettings()
  expect(value.storage.get('ow.settings.v1')).toBe(original)
  // biome-ignore lint/security/noSecrets: fixed localStorage key, not a credential
  expect(value.storage.has('__owQaSettingsBackup')).toBe(false)
})
it('restores absent/malformed settings and preserves a crash backup instead of overwriting it', () => {
  for (const original of [null, '{malformed']) {
    const value = privacyFixture(original)
    expect(value.guard.inspect().graphics).toMatchObject({
      original: null,
      applied: 'auto',
      originalSettingsState: original === null ? 'absent' : 'malformed',
    })
    value.handlers.get('pagehide')?.()
    expect(value.storage.get('ow.settings.v1') ?? null).toBe(original)
  }
  const value = privacyFixture(
    '{"voiceChat":false}',
    JSON.stringify({ value: '{"voiceChat":true,"old":1}' }),
  )
  value.guard.restoreSettings()
  expect(value.storage.get('ow.settings.v1')).toBe('{"voiceChat":true,"old":1}')
})

it('labels explicit tier overrides without changing them or replacing the original crash backup', () => {
  for (const tier of ['low', 'high', 'invalid'] as const) {
    const value = privacyFixture(
      '{"graphics":"auto"}',
      JSON.stringify({ value: '{"graphics":"high","voiceChat":true}' }),
      `#tier=${tier}`,
    )
    const graphics = value.guard.inspect().graphics
    expect(graphics.original).toBe('high')
    expect(graphics.applied).toBe('auto')
    expect(graphics.tierOverrideRaw).toBe(tier)
    expect(graphics.tierOverride).toBe(tier === 'invalid' ? null : tier)
    expect(value.context.location.hash).toBe(`#tier=${tier}`)
    value.guard.restoreSettings()
    expect(value.storage.get('ow.settings.v1')).toBe('{"graphics":"high","voiceChat":true}')
  }
  for (const original of ['null', '[]', '42', '{"graphics":"unexpected"}']) {
    const value = privacyFixture(original)
    expect(JSON.parse(value.storage.get('ow.settings.v1') ?? '{}').graphics).toBe('auto')
    value.guard.restoreSettings()
    expect(value.storage.get('ow.settings.v1')).toBe(original)
  }
})

it('reads current NativePost configuration without inferring it from GL samples or changing it', () => {
  const post = Object.create(NativePost.prototype) as NativePost
  const first = Object.freeze({
    enabled: false,
    rendering: Object.freeze({ samples: 2 }),
    ssao: Object.freeze({ type: 'none', samples: 3 }),
  })
  Reflect.set(post, 'frame', first)
  const before = post.diagnostics()
  expect(before).toEqual({ enabled: false, msaaSamples: 2, ssaoType: 'none', ssaoSamples: 3 })
  Reflect.set(
    post,
    'frame',
    Object.freeze({
      enabled: true,
      rendering: Object.freeze({ samples: 8 }),
      ssao: Object.freeze({ type: 'lighting', samples: 6 }),
    }),
  )
  expect(post.diagnostics()).toEqual({
    enabled: true,
    msaaSamples: 8,
    ssaoType: 'lighting',
    ssaoSamples: 6,
  })
  expect(before.msaaSamples).toBe(2)
  expect(first.rendering.samples).toBe(2)
})

it('retains tier overrides through the local simulator bootstrap URL', () => {
  expect(new URL(preflightURL('http://localhost:4398/#tier=high', 'fixture')).hash).toBe(
    '#tier=high',
  )
})

it('requires actual per-sample tier/post and temporary graphics metadata', () => {
  const value = evidence()
  const sample = value.receipt.recording.samples[0]
  if (!sample) {
    throw new Error('Missing qualification fixture sample')
  }
  Reflect.deleteProperty(sample.game.scene, 'renderer')
  Reflect.deleteProperty(sample.privacy, 'graphics')
  const issues = preflightIssues(value)
  expect(issues).toContain('Actual native renderer tier/post configuration was not captured')
  expect(issues).toContain('Temporary QA graphics selection was not auto')
})

it('does not acknowledge Start/authority readiness as native recording readiness', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const fixture = simulatorHost('http://127.0.0.1:8798', '/unused-no-receipt-write', {
    source: 'revision',
    endSource: 'revision',
    dirty: false,
    qaFlag: true,
    releaseEngine: true,
    contentManifestSha256: 'content',
    scripts: [],
  })
  const mockFetch = Object.assign(
    (input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(
        Response.json(
          String(input).endsWith('performance-config')
            ? { fixture: true, voiceDisabled: true }
            : { accountId: 'local', token: 'synthetic' },
        ),
      ),
    { preconnect: fetch.preconnect },
  )
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(mockFetch)
  const session = (body: unknown) =>
    fixture(
      new Request(`http://localhost/__qa/session/${id}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    )
  try {
    const started = await fixture(new Request(`http://localhost/__qa/start?id=${id}`))
    expect(started?.status).toBe(200)
    const script = (await started?.text())?.split('<script>')[1]?.split('</script>')[0]
    if (!script) {
      throw new Error('Missing local simulator bootstrap script')
    }
    let redirected = ''
    runInNewContext(script, {
      sessionStorage: { setItem: () => undefined },
      location: {
        hash: '#tier=high',
        replace: (value: string) => {
          redirected = value
        },
      },
    })
    expect(redirected).toBe('/experiments/out-west/frontier/?server=remote#tier=high')
    await session({ action: 'ready', page: {} })
    expect(
      recordingAcknowledged(
        await (await fixture(new Request(`http://localhost/__qa/status/${id}`)))?.json(),
      ),
    ).toBe(false)
    const invalid = [
      { running: true, frames: 0 },
      { running: false, frames: 12 },
      { running: true, frames: -1 },
    ]
    const rejected = await Promise.all(
      invalid.map((recording) => session({ action: 'recording', recording })),
    )
    expect(rejected.map((response) => response?.status)).toEqual([409, 409, 409])
    expect(
      (await session({ action: 'recording', recording: { running: true, frames: 3 } }))?.status,
    ).toBe(200)
    expect(
      recordingAcknowledged(
        await (await fixture(new Request(`http://localhost/__qa/status/${id}`)))?.json(),
      ),
    ).toBe(true)
    await session({
      action: 'failed',
      error: 'Tap the game first to enable audio',
      page: { recorder: { audio: [{ state: 'suspended' }] } },
    })
    expect(
      await (await fixture(new Request(`http://localhost/__qa/status/${id}`)))?.json(),
    ).toMatchObject({
      stage: 'failed',
      error: 'Tap the game first to enable audio',
      page: { recorder: { audio: [{ state: 'suspended' }] } },
    })
    expect(
      recordingAcknowledged({
        stage: 'saved',
        recording: { running: true, frames: 3 },
        wall: Date.now(),
      }),
    ).toBe(false)
  } finally {
    mocked.mockRestore()
  }
})

it('decodes actual idb list-apps JSONL without accepting malformed app evidence', () => {
  const app = { bundle_id: 'com.apple.mobilesafari', process_state: 'RUNNING' }
  expect(
    parseIDBApps(`${JSON.stringify(app)}\n${JSON.stringify({ bundle_id: 'other' })}\n`),
  ).toEqual([app, { bundle_id: 'other' }])
  expect(parseIDBApps('\n')).toEqual([])
  expect(() => parseIDBApps('{broken}\n')).toThrow()
  expect(nativeSafari(parseIDBApps(`${JSON.stringify(app)}\n`))).toBeUndefined()
})

it('sends integer native HID coordinates rather than idb marker tokens', () => {
  expect(hidTapArguments(280.5, 118.1)).toEqual([
    'ui',
    'tap',
    '281',
    '118',
    '--api',
    'hid',
    '--duration',
    '0.15',
  ])
  expect(() => hidTapArguments(Number.NaN, 20)).toThrow()
  expect(() => hidTapArguments(20, -1)).toThrow()
})
