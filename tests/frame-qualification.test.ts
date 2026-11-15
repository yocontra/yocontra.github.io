import { expect, test as it } from 'bun:test'
import { type NativeSample, qualifyProductionFixture } from '../tools/content/production-fixture.ts'

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
    scene: { players: 5, actors: { loaded: 5, loading: 0, failed: 0, fallbacks: 0 } },
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
    })),
    history: { ...native, events },
    server: {
      start: 0,
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
