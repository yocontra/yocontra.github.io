import { expect, test as it, spyOn } from 'bun:test'
import type { Page } from 'playwright'
import {
  fixturePopulation,
  OUTDOOR_FIXTURE_CENTER,
  packedFixturePositions,
} from '../api/test/performance-probe.ts'
import { PLAYER_RADIUS } from '../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  buildGrid,
  circleBlocked,
  TOWN,
} from '../src/experiments/out-west/ffa/sim/layout.ts'
import {
  localFixtureURL,
  type NativeSample,
  nativeRendererCaptured,
  prepareProductionFixture,
  qualifyProductionFixture,
  requireLocalPerformanceFixture,
} from '../tools/content/production-fixture.ts'

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Fixture value missing')
  }
  return value
}

function fixture(): Parameters<typeof qualifyProductionFixture>[0] {
  const native: NativeSample = {
    development: false,
    lobbyId: 'fixture',
    tick: 20,
    selfSlot: 0,
    self: { x: 1, z: 1, alive: true, shots: 2 },
    brokenWindows: [],
    scene: {
      players: 5,
      actors: { loaded: 5, loading: 0, failed: 0, fallbacks: 0 },
      renderer: { tier: 'low', nativePost: null },
    },
  }
  const events = ['glass_break', 'kill', 'respawn'].map((type, index) => ({
    type,
    tick: index + 20,
    wall: (index + 10) * 1000,
    at: (index + 10) * 1000,
    self: true,
  }))
  const serverSamples = Array.from({ length: 60 }, (_, index) => ({
    wall: index * 1000,
    tick: index * 20,
    players: 5,
    bots: 4,
    humans: 1,
    window: 0,
    windowBroken: index === 10,
    self: { x: index, y: 0, z: 0, alive: true, shots: index, deaths: 1 },
  }))
  return {
    samples: serverSamples.map(({ wall }, index) => ({
      wall,
      game: { ...native, brokenWindows: index === 10 ? [0] : [] },
      privacy: {
        captureCalls: 0,
        captureBlocked: true,
        voiceChatForcedOff: true,
        graphics: {
          original: 'high',
          originalSettingsState: 'object',
          applied: 'auto',
          tierOverride: null,
          tierOverrideRaw: null,
        },
      },
    })),
    history: { ...native, events },
    server: {
      start: 0,
      aimTicks: 8,
      scriptedServerTransitions: true,
      current: required(serverSamples[59]),
      samples: serverSamples,
      events,
      interventions: [{ type: 'glass-reset', tick: 700, wall: 35_000 }],
    },
    build: {
      source: 'revision',
      endSource: 'revision',
      dirty: false,
      qaFlag: true,
      releaseEngine: true,
      contentManifestSha256: 'content',
      scripts: [{ path: '/game.js', sha256: 'hash' }],
    },
    source: 'revision',
    contentHash: 'content',
    scripts: [{ path: '/game.js', sha256: 'hash' }],
    stress: false,
    start: 0,
    end: 60_000,
  }
}
it('requires matching release build, native readiness, authority and delivered lifecycle evidence', () => {
  expect(qualifyProductionFixture(fixture())).toEqual([])
})
it('captures actual low/high renderer configuration and rejects missing or contradictory records', () => {
  expect(nativeRendererCaptured({ tier: 'low', nativePost: null })).toBe(true)
  expect(
    nativeRendererCaptured({
      tier: 'high',
      nativePost: { enabled: true, msaaSamples: 2, ssaoType: 'none', ssaoSamples: 3 },
    }),
  ).toBe(true)
  expect(nativeRendererCaptured({ tier: 'high', nativePost: null })).toBe(false)
  const value = fixture()
  const first = required(value.samples[0])
  Reflect.deleteProperty(required(first.game).scene, 'renderer')
  expect(qualifyProductionFixture(value)).toContain(
    'Actual native renderer tier/post configuration was not captured',
  )
  required(first.privacy).graphics.tierOverride = 'high'
  expect(qualifyProductionFixture(value)).toContain(
    'Actual native renderer tier differs from the explicit override',
  )
})
it('preserves an explicit graphics tier through the actual Chrome fixture navigation', async () => {
  let navigated = ''
  const page = {
    addInitScript: async () => undefined,
    waitForResponse: async () => ({
      json: async () => ({ lobbyId: 'canonical', reservation: { roomId: 'wire' } }),
    }),
    goto: (url: string) => {
      navigated = url
      return Promise.resolve(undefined)
    },
    waitForFunction: async () => undefined,
    evaluate: async () => ({ lobbyId: 'canonical' }),
  } as unknown as Page
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        if (String(input).endsWith('performance-config')) {
          return Promise.resolve(Response.json({ fixture: true, voiceDisabled: true }))
        }
        if (String(input).endsWith('seed')) {
          return Promise.resolve(Response.json({ accountId: 'fixture', token: 'synthetic' }))
        }
        return Promise.resolve(Response.json({ ok: true, players: 5, bots: 4 }))
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    await prepareProductionFixture(
      page,
      'http://localhost:4398/#tier=high',
      'http://localhost:8798',
      false,
    )
    expect(navigated).toBe(
      'http://localhost:4398/experiments/out-west/frontier/?server=remote#tier=high',
    )
  } finally {
    mocked.mockRestore()
  }
})
it('rejects stress labels without 32 actual loaded and authoritative riders', () => {
  const value = fixture()
  value.stress = true
  expect(qualifyProductionFixture(value)).toContain(
    'Native loaded rider count or readiness was not stable',
  )
  expect(qualifyProductionFixture(value)).toContain(
    'Authoritative ordinary/stress population not established',
  )
})
it('rejects fallbacks, stale content and served script drift', () => {
  const value = fixture()
  required(required(value.samples[0]).game).scene.actors.fallbacks = 1
  value.contentHash = 'changed'
  required(value.scripts[0]).sha256 = 'changed'
  const result = qualifyProductionFixture(value)
  expect(result).toContain('Native loaded rider count or readiness was not stable')
  expect(result).toContain(
    'Clean matching QA build/content and release-engine provenance unavailable',
  )
  expect(result).toContain('Loaded JavaScript differs from the build receipt')
})
it('does not count stale client events or a server reset that was never presented', () => {
  const value = fixture()
  required(value.history).events = required(value.history?.events).map((event) => ({
    ...event,
    wall: -1,
  }))
  for (const sample of value.samples) {
    required(sample.game).brokenWindows = [0]
  }
  const result = qualifyProductionFixture(value)
  expect(result).toContain('Confirmed and delivered respawn event missing')
  expect(result).toContain('Authoritative glass reset was not presented')
})

it('requires authoritative ADS rather than only desktop mouse input', () => {
  const value = fixture()
  required(value.server).aimTicks = 0
  expect(qualifyProductionFixture(value)).toContain('Authoritative ADS input not confirmed')
})
it('refuses external, credentialed, or provider-enabled performance fixtures', () => {
  // biome-ignore lint/security/noSecrets: deliberately invalid synthetic credential URL
  for (const url of ['https://example.com', 'http://user:pass@localhost', 'ftp://localhost']) {
    expect(() => localFixtureURL(url)).toThrow()
  }
  for (const config of [
    { fixture: false, voiceDisabled: true },
    { fixture: true },
    { fixture: true, voiceDisabled: false },
  ]) {
    expect(() => requireLocalPerformanceFixture('http://127.0.0.1:8798', config)).toThrow()
  }
  expect(() =>
    requireLocalPerformanceFixture('http://localhost:8798', { fixture: true, voiceDisabled: true }),
  ).not.toThrow()
})
it('packs exactly 32 nonoverlapping capsules on the actual town grid', () => {
  const grid = buildGrid(TOWN)
  const points = packedFixturePositions(grid, OUTDOOR_FIXTURE_CENTER)
  expect(points).toHaveLength(32)
  for (const [index, point] of points.entries()) {
    expect(circleBlocked(grid, { ...point, r: PLAYER_RADIUS }, BLOCK_MOVE)).toBe(false)
    expect(
      TOWN.buildings.every(
        (b) =>
          point.x + PLAYER_RADIUS <= b.x ||
          point.x - PLAYER_RADIUS >= b.x + b.w ||
          point.z + PLAYER_RADIUS <= b.z ||
          point.z - PLAYER_RADIUS >= b.z + b.d,
      ),
    ).toBe(true)
    expect(point.x).toBeGreaterThanOrEqual(PLAYER_RADIUS)
    expect(point.z).toBeGreaterThanOrEqual(PLAYER_RADIUS)
    expect(point.x).toBeLessThanOrEqual(grid.size - PLAYER_RADIUS)
    expect(point.z).toBeLessThanOrEqual(grid.size - PLAYER_RADIUS)
    for (const other of points.slice(index + 1)) {
      expect(Math.hypot(point.x - other.x, point.z - other.z)).toBeGreaterThanOrEqual(
        PLAYER_RADIUS * 2 + 0.1,
      )
    }
  }
  expect(() => packedFixturePositions(grid, { x: 0, z: 0 })).toThrow('blocked')
  expect(() => packedFixturePositions(grid, { x: 72, z: 66 }, 33)).toThrow('population')
  expect(() =>
    packedFixturePositions(
      { ...grid, size: 1, n: 2, cell: 0.5, cells: new Uint8Array(4) },
      { x: 0.5, z: 0.5 },
      2,
    ),
  ).toThrow('Insufficient')
})

it('rejects missing native samples even when authoritative fixture data is present', () => {
  const value = fixture()
  value.samples = []
  expect(qualifyProductionFixture(value)).toContain(
    'Native loaded rider count or readiness was not stable',
  )
})

it('prepares five ordinary riders without raising the four-bot cap and rejects invalid populations', () => {
  expect(fixturePopulation(undefined)).toBe(32)
  expect(fixturePopulation(5)).toBe(5)
  expect(fixturePopulation(32)).toBe(32)
  for (const value of [0, 4, 31, 33, '5', null, Number.NaN]) {
    expect(() => fixturePopulation(value)).toThrow()
  }
  const points = packedFixturePositions(buildGrid(TOWN), OUTDOOR_FIXTURE_CENTER, 5)
  expect(points).toHaveLength(5)
  expect(points[0]).toEqual({ x: 52, z: 52 })
})
