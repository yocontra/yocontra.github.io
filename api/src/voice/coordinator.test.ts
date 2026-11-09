import { afterEach, expect, test as it, spyOn } from 'bun:test'
import { sleep } from 'bun'
import type { VoiceServerControl } from '../../../src/experiments/out-west/contract/voice.ts'
import type { Env } from '../env.ts'
import { VoiceCoordinator, type VoiceStorage } from './coordinator.ts'
import type { VoicePeer } from './proximity.ts'

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  REALTIMEKIT_APP_ID: 'test-app',
  REALTIMEKIT_API_TOKEN: 'test-only',
  REALTIMEKIT_PRESET: 'voice',
} as Env
const coordinators: VoiceCoordinator[] = []
const restore: (() => void)[] = []
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((voice) => voice.close()))
  for (const close of restore.splice(0)) {
    close()
  }
})
function peer(id: number, x = id): VoicePeer {
  return { id, name: `Rider ${id}`, x, z: 0, human: true, connected: true, available: true }
}
function harness() {
  let now = 10_000
  let state: VoiceStorage | undefined
  let fails = ''
  let heldPath = ''
  let unblock: (() => void) | undefined
  let allocations = 0
  let budgetAllowed = true
  let budgetError = false
  const reservations: number[] = []
  const peers = [peer(0), peer(1)]
  const calls: { path: string; method: string }[] = []
  const messages: { id: number; control: VoiceServerControl }[] = []
  const jobs: Promise<unknown>[] = []
  const live = new Set<string>()
  const implementation = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    calls.push({ path, method })
    if (heldPath && path.endsWith(heldPath)) {
      await new Promise<void>((resolve) => {
        unblock = resolve
      })
    }
    if (fails && path.includes(fails)) {
      return Response.json({ success: false }, { status: 500 })
    }
    if (path.endsWith('/meetings')) {
      return Response.json({ success: true, data: { id: `meeting-${++allocations}` } })
    }
    if (path.endsWith('/participants') && method === 'POST') {
      const id = `participant-${calls.length}`
      live.add(id)
      return Response.json({ success: true, data: { id, token: 'test-only-token' } })
    }
    if (method === 'DELETE') {
      live.delete(path.split('/').at(-1) ?? '')
    }
    return Response.json({ success: true, data: {} })
  }
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  )
  restore.push(() => spy.mockRestore())
  const make = () => {
    const voice = new VoiceCoordinator({
      env,
      reserve: (count) => {
        reservations.push(count)
        if (budgetError) {
          return Promise.reject(new Error('Fixture D1 unavailable'))
        }
        return Promise.resolve(budgetAllowed)
      },
      title: () => 'voice-lifecycle-test',
      peers: () => peers,
      send: (id, control) => {
        messages.push({ id, control })
      },
      save: (value) => {
        state = structuredClone(value)
        return Promise.resolve()
      },
      reschedule: () => Promise.resolve(),
      waitUntil: (work) => {
        jobs.push(work)
      },
      now: () => now,
    })
    coordinators.push(voice)
    return voice
  }
  const voice = make()
  return {
    voice,
    make,
    reservations,
    budget: (allowed: boolean, error = false) => {
      budgetAllowed = allowed
      budgetError = error
    },
    peers,
    calls,
    messages,
    live,
    state: () => state,
    advance: (ms: number) => {
      now += ms
      voice.update(true)
    },
    fail: (path: string) => {
      fails = path
    },
    hold: (path: string) => {
      heldPath = path
    },
    release: () => {
      heldPath = ''
      unblock?.()
    },
    async drain() {
      for (let i = 0; i < 20 && jobs.length > 0; i++) {
        await Promise.all(jobs.splice(0))
      }
    },
    register() {
      voice.handle(0, { type: 'voice_on' })
      voice.handle(1, { type: 'voice_on' })
    },
    speak(on = true) {
      voice.handle(0, { type: 'voice_talk', talking: on })
    },
  }
}

it('no provider work for disabled, idle, bots, alone or inaudible people; speech plus audience allocates', async () => {
  const h = harness()
  h.voice.update(true)
  h.voice.handle(0, { type: 'voice_on' })
  h.speak()
  await h.drain()
  expect(h.calls).toHaveLength(0)
  h.peers[1] = { ...peer(1), human: false }
  h.voice.handle(1, { type: 'voice_on' })
  await h.drain()
  expect(h.calls).toHaveLength(0)
  h.peers[1] = peer(1, 30)
  h.voice.handle(1, { type: 'voice_on' })
  await h.drain()
  expect(h.calls).toHaveLength(0)
  h.peers[1] = peer(1)
  h.voice.handle(1, { type: 'voice_on', listening: false })
  await h.drain()
  expect(h.calls).toHaveLength(0)
  h.voice.handle(1, { type: 'voice_on', muted: [0] })
  await h.drain()
  expect(h.calls).toHaveLength(0)
  h.voice.handle(1, { type: 'voice_on' })
  await h.drain()
  expect(h.calls.filter((call) => call.path.endsWith('/meetings'))).toHaveLength(1)
  expect(h.messages.filter((message) => message.control.type === 'voice_ready')).toHaveLength(2)
  expect(h.live.size).toBe(2)
})

it('silence, stale leases and final disconnect end sessions and revoke all participant tokens', async () => {
  const h = harness()
  h.register()
  await h.drain()
  expect(h.calls).toHaveLength(0)
  h.speak()
  await h.drain()
  h.speak(false)
  await h.drain()
  expect(h.live.size).toBe(2)
  h.advance(1001)
  await h.drain()
  expect(h.live.size).toBe(0)
  expect(h.calls.some((call) => call.path.endsWith('/active-session/kick-all'))).toBe(true)
  h.speak()
  await h.drain()
  h.advance(2501)
  h.advance(1001)
  await h.drain()
  expect(h.live.size).toBe(0)
  expect(h.voice.resources.timers).toBe(0)
  h.speak()
  await h.drain()
  h.voice.drop(1)
  await h.drain()
  expect(h.live.size).toBe(0)
  await h.voice.close()
  expect(h.voice.resources).toEqual({ interests: 0, intents: 0, members: 0, cleanup: 0, timers: 0 })
})

it('heartbeat extends only an active intent; listener arriving while talking joins lazily', async () => {
  const h = harness()
  h.voice.handle(0, { type: 'voice_on' })
  h.speak()
  await h.drain()
  expect(h.calls).toHaveLength(0)
  h.advance(2000)
  h.speak()
  h.voice.handle(1, { type: 'voice_on' })
  await h.drain()
  expect(h.live.size).toBe(2)
  h.advance(2000)
  await h.drain()
  expect(h.live.size).toBe(2)
  h.voice.drop(0)
  await h.drain()
  expect(h.live.size).toBe(0)
})

it('failed teardown is durably retried after a cold restore with no world or active-only timers', async () => {
  const h = harness()
  h.register()
  h.speak()
  await h.drain()
  h.fail('/active-session/kick-all')
  await h.voice.close()
  expect(h.voice.resources.timers).toBe(0)
  expect(h.voice.resources.members).toBe(0)
  expect(h.state()?.cleanup?.[0]?.ended).toBe(false)
  expect(h.voice.nextRetry).toBe(15_000)
  const cold = h.make()
  await cold.restore(h.state())
  const creations = h.calls.filter((call) => call.path.endsWith('/meetings')).length
  h.fail('')
  h.advance(5001)
  await cold.retry()
  expect(h.live.size).toBe(0)
  expect(cold.resources).toEqual({ interests: 0, intents: 0, members: 0, cleanup: 0, timers: 0 })
  expect(h.calls.filter((call) => call.path.endsWith('/meetings'))).toHaveLength(creations)
})

it('participant revocation failure survives a successful kick and retries only failed deletes', async () => {
  const h = harness()
  h.register()
  h.speak()
  await h.drain()
  h.fail('/participants/')
  await h.voice.close()
  const saved = h.state()
  expect(saved?.cleanup?.[0]?.ended).toBe(true)
  expect(saved?.cleanup?.[0]?.participants).toHaveLength(2)
  const kicks = h.calls.filter((call) => call.path.endsWith('/kick-all')).length
  const cold = h.make()
  await cold.restore(saved)
  h.fail('')
  h.advance(5001)
  await cold.retry()
  expect(h.live.size).toBe(0)
  expect(h.calls.filter((call) => call.path.endsWith('/kick-all'))).toHaveLength(kicks)
})

it('a late provider allocation after close gets revoked and never delivers credentials', async () => {
  const h = harness()
  h.hold('/participants')
  h.register()
  h.speak()
  for (let i = 0; i < 20 && h.calls.length < 2; i++) {
    await sleep(1)
  }
  expect(h.calls.length).toBe(2)
  await h.voice.close()
  h.release()
  await h.drain()
  expect(h.messages.filter((message) => message.control.type === 'voice_ready')).toHaveLength(0)
  expect(h.live.size).toBe(0)
  expect(h.voice.resources.timers).toBe(0)
})

it('free-budget admission reserves only needed humans and denial creates no provider resources', async () => {
  const h = harness()
  h.register()
  await h.drain()
  expect(h.reservations).toHaveLength(0)
  h.budget(false)
  h.speak()
  await h.drain()
  expect(h.calls).toHaveLength(0)
  expect(h.reservations).toEqual([2])
  expect(
    h.messages.some(
      ({ control }) =>
        control.type === 'voice_error' && control.message.includes('free safety budget'),
    ),
  ).toBe(true)
  await h.voice.close()
  expect(h.voice.resources.timers).toBe(0)
})

it('an active lease renews conservatively and a denied renewal ends and revokes the session', async () => {
  const h = harness()
  h.register()
  h.speak()
  await h.drain()
  expect(h.reservations).toEqual([2])
  h.advance(19_000)
  h.speak()
  await h.drain()
  h.advance(1000)
  await h.drain()
  expect(h.reservations).toEqual([2, 2])
  h.budget(false)
  h.advance(19_000)
  h.speak()
  await h.drain()
  h.advance(1000)
  await h.drain()
  expect(h.live.size).toBe(0)
  expect(h.voice.resources.members).toBe(0)
  await h.voice.close()
  expect(h.voice.resources.timers).toBe(0)
})
