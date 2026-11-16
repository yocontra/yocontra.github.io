/** Authenticated local Worker coordination; no mutable client debug hooks. */
import type { Page } from 'playwright'
import type { PerformanceProbe } from '../../api/test/performance-probe.ts'

export interface NativeSample {
  development: boolean
  lobbyId: string
  tick: number
  selfSlot: number
  self?: { x: number; z: number; alive: boolean; shots: number; lastButtons?: number }
  brokenWindows: number[]
  scene: {
    players: number
    actors: { loaded: number; loading: number; failed: number; fallbacks: number }
  }
  events?: { type: string; tick: number; at: number; wall: number; self: boolean }[]
}
export interface BuildReceipt {
  source: string
  endSource: string
  dirty: boolean
  qaFlag: boolean
  releaseEngine: boolean
  contentManifestSha256: string
  scripts: { path: string; sha256: string; local?: boolean }[]
}
const post = async (api: string, path: string, body: unknown) => {
  const response = await fetch(`${api}/__test/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Local fixture ${path}: HTTP ${response.status}`)
  }
  return response.json() as Promise<Record<string, unknown>>
}
export function localFixtureURL(address: string): URL {
  const url = new URL(address)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Local HTTP fixture URL required')
  }
  return url
}
export function requireLocalPerformanceFixture(api: string, config: unknown): void {
  localFixtureURL(api)
  const value = config as { fixture?: boolean; voiceDisabled?: boolean } | null
  if (value?.fixture !== true || value.voiceDisabled !== true) {
    throw new Error('Performance recording requires a local fixture with voice/providers disabled')
  }
}
export async function prepareProductionFixture(
  page: Page,
  origin: string,
  api: string,
  stress: boolean,
) {
  localFixtureURL(api)
  localFixtureURL(origin)
  requireLocalPerformanceFixture(
    api,
    await (await fetch(`${api}/__test/performance-config`)).json(),
  )
  const seed = await fetch(`${api}/__test/seed`)
  if (!seed.ok) {
    throw new Error(`Fixture seed failed: ${seed.status}`)
  }
  const account = (await seed.json()) as { token: string; accountId: string }
  const url = new URL('/experiments/out-west/frontier/', origin)
  url.search = new URLSearchParams({ server: 'remote' }).toString()
  await page.addInitScript(
    (credentials) => sessionStorage.setItem('__owQaAccount', JSON.stringify(credentials)),
    { api, token: account.token },
  )
  const joined = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/town/native/join' && response.ok(),
    { timeout: 120_000 },
  )
  await page.goto(url.href, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__owPerformanceSnapshot')?.().scene.actors.loaded > 0,
    null,
    { timeout: 120_000 },
  )
  const admission = (await (await joined).json()) as {
    lobbyId: string
    reservation: { roomId: string }
  }
  const native: NativeSample = await page.evaluate(() =>
    Reflect.get(globalThis, '__owPerformanceSnapshot')(),
  )
  if (
    typeof admission.reservation.roomId !== 'string' ||
    native.lobbyId !== admission.lobbyId ||
    native.lobbyId === admission.reservation.roomId
  ) {
    throw new Error('Native session did not preserve the authoritative lobby identity')
  }
  const identity = { lobbyId: native.lobbyId, accountId: account.accountId }
  const count = stress ? 32 : 5
  const preparation = await post(api, 'packed-town', { ...identity, players: count })
  if (!(preparation.ok && preparation.players === count && preparation.bots === count - 1)) {
    throw new Error(`Outdoor Worker did not reach ${count} riders`)
  }
  await page.waitForFunction(
    (players) => {
      const snapshot: NativeSample = Reflect.get(globalThis, '__owPerformanceSnapshot')()
      const actors = snapshot.scene.actors
      return (
        snapshot.scene.players === players &&
        actors.loaded === players &&
        actors.loading === 0 &&
        actors.failed === 0 &&
        actors.fallbacks === 0 &&
        !document.querySelector('.pc-loading')
      )
    },
    count,
    { timeout: 120_000 },
  )
  return {
    preparation,
    start: async () => {
      const result = await post(api, 'performance', { ...identity, start: true })
      if (!result.ok) {
        throw new Error(
          `Worker performance observation did not start: ${String(result.error ?? 'unknown')}`,
        )
      }
    },
    finish: async () => {
      const result = await post(api, 'performance', identity)
      if (!result.ok) {
        throw new Error('Worker performance observation disappeared')
      }
      return result.receipt as ReturnType<PerformanceProbe['snapshot']>
    },
  }
}

export function qualifyProductionFixture(options: {
  samples: { wall: number; game?: NativeSample }[]
  history?: NativeSample
  server?: ReturnType<PerformanceProbe['snapshot']>
  build?: BuildReceipt
  source: string
  contentHash: string
  scripts: { path: string; sha256: string; local?: boolean }[]
  stress: boolean
  start: number
  end: number
}) {
  const { samples, server, build, history, source, scripts, stress, start, end } = options
  const problems: string[] = []
  const count = stress ? 32 : 5
  if (
    !(
      build?.qaFlag &&
      build.releaseEngine &&
      !build.dirty &&
      build.source === source &&
      build.endSource === source &&
      build.contentManifestSha256 === options.contentHash
    )
  ) {
    problems.push('Clean matching QA build/content and release-engine provenance unavailable')
  }
  if (
    scripts.some(
      (script) =>
        script.local !== false &&
        !['/__qa/recorder.js', '/__qa/controller.js'].includes(script.path) &&
        !build?.scripts.some(
          (built) => built.path === script.path && built.sha256 === script.sha256,
        ),
    )
  ) {
    problems.push('Loaded JavaScript differs from the build receipt')
  }
  if (
    samples.length < 55 ||
    samples.some(
      ({ game }) =>
        !game ||
        game.development ||
        game.scene.players !== count ||
        game.scene.actors.loaded !== count ||
        game.scene.actors.loading !== 0 ||
        game.scene.actors.failed !== 0 ||
        game.scene.actors.fallbacks !== 0,
    )
  ) {
    problems.push('Native loaded rider count or readiness was not stable')
  }
  const authority =
    server?.samples.filter((sample) => sample.wall >= start && sample.wall <= end) ?? []
  if (!(server && server.aimTicks > 0)) {
    problems.push('Authoritative ADS input not confirmed')
  }
  if (
    authority.length < 55 ||
    authority.some(
      (sample) => sample.players !== count || sample.bots !== count - 1 || sample.humans !== 1,
    )
  ) {
    problems.push('Authoritative ordinary/stress population not established')
  }
  const first = authority[0]?.self
  if (
    !(
      first &&
      authority.some(
        ({ self }) =>
          self && Math.hypot(self.x - first.x, self.z - first.z) > 0.5 && self.shots > first.shots,
      )
    )
  ) {
    problems.push('Authoritative movement and firing not confirmed')
  }
  for (const type of ['glass_break', 'kill', 'respawn']) {
    const confirmed =
      server?.events.filter(
        (event) =>
          event.wall >= start &&
          event.wall <= end &&
          event.type === type &&
          (type === 'glass_break' || event.self),
      ) ?? []
    const delivered = confirmed.some((serverEvent) =>
      history?.events?.some(
        (event) =>
          event.type === type &&
          event.wall >= start &&
          event.wall <= end &&
          Math.abs(event.wall - serverEvent.wall) < 2000 &&
          (type === 'glass_break' || event.self),
      ),
    )
    if (!delivered) {
      problems.push(`Confirmed and delivered ${type} event missing`)
    }
  }
  const pane = server?.current.window ?? -1
  const broken = samples.findIndex(({ game }) => game?.brokenWindows.includes(pane))
  if (
    pane < 0 ||
    broken < 0 ||
    !samples.slice(broken + 1).some(({ game }) => game && !game.brokenWindows.includes(pane)) ||
    !server?.interventions.some(
      (event) => event.type === 'glass-reset' && event.wall >= start && event.wall <= end,
    )
  ) {
    problems.push('Authoritative glass reset was not presented')
  }
  return problems
}
