import { expect, test as it, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameTarget } from '../tools/content/frame-target.ts'
import { frameTiming } from '../tools/content/frame-timing.ts'
import {
  finalRecordingVerdict,
  gestureTape,
  joinGestures,
  nativeForeground,
  nativeTransform,
  recordingMode,
  recordingOptions,
  walkingEvidence,
} from '../tools/content/simulator-hid.ts'
import { simulatorHost } from '../tools/content/simulator-host.ts'
import {
  commandPlan,
  preflightIssues,
  targetForPreflight,
} from '../tools/content/simulator-native.ts'

const web = { x: 0, y: 100, width: 375, height: 664 }
const page = {
  url: 'http://127.0.0.1:4398/experiments/out-west/frontier/?server=remote',
  visible: 'visible',
  focused: true,
  width: 375,
  height: 664,
  canvas: { x: 0, y: 0, width: 375, height: 664 },
}
const buttons = Object.fromEntries(
  ['FIRE', 'AIM', 'RELOAD'].map((name, i) => [
    name,
    { x: 280, y: 400 + i * 50, width: 50, height: 40 },
  ]),
)
const clock = { at: 1000, wall: 100_000 }
const tape = gestureTape({ page, web, buttons, clock, orientation: 'portrait' })
const events = tape.flatMap((g) => {
  const css = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - web.y })
  const down = { at: g.at, type: 'pointerdown', pointerId: g.id, ...css(g.start) }
  const up = { at: g.at + g.duration, type: 'pointerup', pointerId: g.id, ...css(g.end) }
  return g.kind === 'swipe'
    ? [
        down,
        {
          at: g.at + g.duration / 2,
          type: 'pointermove',
          pointerId: g.id,
          x: (g.start.x + g.end.x) / 2,
          y: (g.start.y + g.end.y) / 2 - web.y,
        },
        up,
      ]
    : [down, up]
})
const safari = { AXRole: 'AXApplication', bundleIdentifier: 'com.apple.mobilesafari', pid: 42 }
it('accepts only ordinary/stress and proved portrait/landscape native geometry', () => {
  expect(recordingOptions('ordinary', 'portrait')).toEqual({
    population: 'ordinary',
    orientation: 'portrait',
    seconds: 60,
  })
  expect(recordingOptions('stress', 'landscape').seconds).toBe(60)
  expect(() => recordingOptions('small', 'portrait')).toThrow()
  expect(() => nativeTransform(web, page, 'landscape')).toThrow()
  expect(() => nativeTransform({ ...web, height: 640 }, page, 'portrait')).toThrow()
  expect(nativeTransform(web, page, 'portrait').point(100.4, 200.5)).toEqual({ x: 100, y: 301 })
  expect(() => nativeTransform(web, page, 'portrait').point(-1, 0)).toThrow()
  const landscape = {
    ...page,
    width: 664,
    height: 375,
    canvas: { x: 0, y: 0, width: 664, height: 375 },
  }
  expect(
    nativeTransform({ x: 0, y: 50, width: 664, height: 375 }, landscape, 'landscape').point(
      200,
      100,
    ),
  ).toEqual({ x: 200, y: 150 })
})
it('predeclares the full bounded tape on the actual guest clock, requiring fresh AX control frames', () => {
  expect(tape).toHaveLength(54)
  expect(tape[0]?.at).toBe(clock.at + 1500)
  expect(tape.every((g) => g.at + g.duration < clock.at + 60_000)).toBe(true)
  expect(new Set(tape.map((g) => g.role))).toEqual(
    new Set(['move', 'look', 'FIRE', 'AIM', 'RELOAD']),
  )
  expect(() =>
    gestureTape({
      page,
      web,
      buttons: { ...buttons, FIRE: { x: -200, y: 0, width: 1, height: 1 } },
      clock,
      orientation: 'portrait',
    }),
  ).toThrow()
  expect(() => gestureTape({ page, web, buttons: {}, clock, orientation: 'portrait' })).toThrow(
    'Native AX button missing',
  )
  expect(() =>
    gestureTape({
      page,
      web,
      buttons,
      clock: { at: Number.NaN, wall: 1 },
      orientation: 'portrait',
    }),
  ).toThrow()
})
it('joins every native down/up, durations and swipe shape without altering raw events or tolerance', () => {
  const before = JSON.stringify(events)
  const result = joinGestures(tape, events, web, page)
  expect(result.passed).toBe(true)
  expect(result.endpoints).toHaveLength(108)
  expect(result.toleranceMs).toBe(35)
  expect(JSON.stringify(events)).toBe(before)
  const missed = events.map((e, i) => (i === 0 ? { ...e, at: e.at + 36 } : e))
  expect(joinGestures(tape, missed, web, page).passed).toBe(false)
  expect(joinGestures(tape, events.slice(1), web, page).endpoints[0]?.observed).toBeNull()
  expect(
    joinGestures(
      tape,
      events.filter((e) => e.type !== 'pointermove'),
      web,
      page,
    ).passed,
  ).toBe(false)
  const skewed = events.map((e, i) => (i === 1 ? { ...e, x: e.x + 40 } : e))
  expect(joinGestures(tape, skewed, web, page).shapes[0]?.passed).toBe(false)
  const overshoot = events.map((e, i) => (i === 1 ? { ...e, y: -100 } : e))
  expect(joinGestures(tape, overshoot, web, page).shapes[0]?.passed).toBe(false)
})
it('keeps every partial input and endpoint even when the native transport stops midway', () => {
  const result = joinGestures(tape, events.slice(0, 7), web, page)
  expect(result.passed).toBe(false)
  expect(result.rawInputCount).toBe(7)
  expect(result.endpoints).toHaveLength(108)
  expect(result.endpoints.some((e) => e.observed === null)).toBe(true)
})
it('requires positive stable native application identity and complete orientation/foreground coverage', () => {
  const samples = Array.from({ length: 61 }, (_, i) => ({
    wall: 1000 + i * 1000,
    ax: safari,
    orientation: 'PORTRAIT',
  }))
  const expected = { start: 1000, end: 61_000, orientation: 'PORTRAIT' }
  expect(nativeForeground(samples, expected).passed).toBe(true)
  expect(nativeForeground(samples.slice(2), expected).passed).toBe(false)
  expect(
    nativeForeground(
      samples.filter((_, i) => i !== 15),
      expected,
    ).passed,
  ).toBe(false)
  expect(
    nativeForeground(
      samples.map((s, i) => (i === 2 ? { ...s, ax: { ...safari, pid: 43 } } : s)),
      expected,
    ).passed,
  ).toBe(false)
  expect(
    nativeForeground(
      samples.map((s) => ({ ...s, ax: { AXLabel: 'Safari', state: 'RUNNING', pid: 42 } })),
      expected,
    ).passed,
  ).toBe(false)
  expect(nativeForeground(samples, { ...expected, orientation: 'LANDSCAPE_LEFT' }).passed).toBe(
    false,
  )
  expect(
    nativeForeground(samples, { start: 2000, end: 1000, orientation: 'PORTRAIT' }).passed,
  ).toBe(false)
})
it('retains an empty slow second and fails the30FPS floor despite a fast mean', () => {
  const timestamps = Array.from({ length: 3601 }, (_, i) => (i * 1000) / 60).filter(
    (t) => t <= 30_000 || t > 31_000,
  )
  const timing = frameTiming(timestamps)
  expect(timing.bins.filter((b) => b.durationMs === 1000)).toHaveLength(60)
  expect(timing.intervals.some((ms) => ms > 1000)).toBe(true)
  expect(timing.bins[30]?.frames).toBe(0)
  expect(frameTarget(timing, 'simulator').passed).toBe(false)
  expect(timing.fps).toBeGreaterThan(30)
})
it('preserves owned headless preflight commands and refuses an already booted device', () => {
  const udid = '59616A95-4749-4F6F-8E1D-1FAEA0263EFC'
  const plan = commandPlan(udid, 'http://127.0.0.1:4398/__qa/start', 10_892)
  expect(plan.companion).toContain('--headless')
  expect(plan.shutdown).toEqual(['xcrun', 'simctl', 'shutdown', udid])
  expect(() =>
    targetForPreflight(
      {
        devices: {
          iOS: [
            {
              udid,
              name: 'Out West QA iPhone 13 mini',
              isAvailable: true,
              state: 'Booted',
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini',
            },
          ],
        },
      },
      udid,
    ),
  ).toThrow()
  expect(
    preflightIssues({
      beforeAX: safari,
      afterAX: safari,
      expectedURL: page.url,
      receipt: { preflight: false, recording: { completed: false, timestamps: [] } },
      seconds: 60,
    }),
  ).toContain('Completed native recording not established')
})

it('excludes a death/respawn teleport from walking while retaining every segment', () => {
  const self = (x: number, alive = true, deaths = 0) => ({ x, z: 0, alive, deaths })
  const result = walkingEvidence([
    { wall: 0, self: self(0) },
    { wall: 1000, self: self(1) },
    { wall: 2000, self: self(1, false, 1) },
    { wall: 3000, self: self(90, true, 1) },
    { wall: 4000, self: self(91, true, 1) },
  ])
  expect(result.segments).toHaveLength(4)
  expect(result.distance).toBe(2)
  expect(result.segments[2]?.included).toBe(false)
  expect(
    walkingEvidence([
      { wall: 0, self: self(0) },
      { wall: 1000, self: self(90) },
    ]).distance,
  ).toBe(0)
})
it('keeps failed FPS distinct from incomplete evidence and rejects every failed teardown gate', () => {
  const complete = {
    settingsRestored: true,
    orientationRestored: true,
    deviceShutdown: true,
    ownedPidsAbsent: true,
    nativePortFree: true,
    nativeClient: { exitCode: 0, pipeDrainComplete: true },
  }
  expect(finalRecordingVerdict([], { passed: false }, complete)).toEqual({
    qualification: 'complete',
    performanceTarget: 'fail',
  })
  expect(
    finalRecordingVerdict(['late gesture'], { passed: true }, complete).performanceTarget,
  ).toBe('unqualified')
  for (const key of [
    'settingsRestored',
    'orientationRestored',
    'deviceShutdown',
    'ownedPidsAbsent',
    'nativePortFree',
  ]) {
    expect(
      finalRecordingVerdict([], { passed: true }, { ...complete, [key]: false }).qualification,
    ).toBe('incomplete')
  }
  expect(
    finalRecordingVerdict(
      [],
      { passed: true },
      { ...complete, nativeClient: { exitCode: 0, pipeDrainComplete: false } },
    ).qualification,
  ).toBe('incomplete')
  expect(
    finalRecordingVerdict([], { passed: true }, { ...complete, nativeClient: { exitCode: 1 } })
      .qualification,
  ).toBe('incomplete')
})

it('validates full CLI mode/duration before any native command', () => {
  expect(recordingMode(['--preflight'])).toBe('preflight')
  expect(recordingMode(['--record', '--population=stress', '--orientation=landscape'])).toBe(
    'record',
  )
  expect(() => recordingMode([])).toThrow()
  expect(() => recordingMode(['--preflight', '--record'])).toThrow()
  expect(() => recordingMode(['--record', '--seconds=90'])).toThrow()
})
it('persists raw partial browser frames when the page fails, including an empty tape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'out-west-recorder-test-'))
  const mockFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) =>
      Response.json(
        String(input).endsWith('performance-config')
          ? { fixture: true, voiceDisabled: true }
          : { accountId: 'local-qa', token: 'fixture-only' },
      ),
    { preconnect: fetch.preconnect },
  )
  const mock = spyOn(globalThis, 'fetch').mockImplementation(mockFetch)
  try {
    const host = simulatorHost('http://127.0.0.1:8798', directory, {
      source: 'pinned',
      endSource: 'pinned',
      dirty: false,
      qaFlag: true,
      releaseEngine: true,
      contentManifestSha256: 'content',
      scripts: [],
    })
    for (const [index, timestamps] of [
      [0, []],
      [1, [0, 16, 150]],
    ] as const) {
      const id = `11111111-1111-4111-8111-11111111111${index}`
      await host(new Request(`http://127.0.0.1:4398/__qa/start?id=${id}`))
      await host(
        new Request(`http://127.0.0.1:4398/__qa/session/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'failed',
            error: 'native page stopped',
            recording: { timestamps, inputs: [], completed: false },
          }),
        }),
      )
      const stored = JSON.parse(await readFile(join(directory, `simulator-${id}.json`), 'utf8'))
      expect(stored.recording.timestamps).toEqual(timestamps)
      expect(stored.qualification).toBe('incomplete')
      const status = await host(new Request(`http://127.0.0.1:4398/__qa/status/${id}`))
      expect(await status?.json()).toMatchObject({
        stage: 'failed',
        receipt: { recording: { timestamps } },
      })
    }
  } finally {
    mock.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
