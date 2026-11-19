import assert from 'node:assert/strict'
import process from 'node:process'
import { test as it } from 'node:test'
import { Client, type Room } from '@colyseus/sdk'
import type { ISeatReservation } from '@colyseus/shared-types'

interface State {
  tick: number
  heights: ReadonlyMap<string, number>
}

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8787')
const run = crypto.randomUUID().slice(0, 8)
const primary = `${run}-one`
const secondary = `${run}-two`
const clients: Room<State>[] = []

function endpoint(path: string, room: string, player?: string) {
  const url = new URL(path, base)
  url.searchParams.set('room', room)
  if (player) {
    url.searchParams.set('player', player)
  }
  return url
}

async function reserve(room: string, player: string) {
  const response = await fetch(endpoint('/reserve', room, player), {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(`Seat request failed: ${response.status}`)
  }
  return (await response.json()) as ISeatReservation
}

async function join(room: string, player: string, seat: ISeatReservation) {
  const client = await new Client(
    endpoint('/', room, player).toString(),
  ).consumeSeatReservation<State>(seat)
  clients.push(client)
  return client
}

async function active(room: string) {
  const response = await fetch(endpoint('/status', room), { signal: AbortSignal.timeout(5000) })
  const status = (await response.json()) as { active: boolean }
  return status.active
}

function observe(room: Room<State>, predicate: (state: State) => boolean, label: string) {
  if (room.state?.heights && predicate(room.state)) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      room.onStateChange.remove(receive)
      reject(new Error(`${label}: ${JSON.stringify(room.state)}`))
    }, 5000)
    function receive(state: State) {
      if (state.heights && predicate(state)) {
        clearTimeout(timeout)
        room.onStateChange.remove(receive)
        resolve()
      }
    }
    room.onStateChange(receive)
  })
}

await it('autonomous Bullet state, remote input, room isolation and disposal', {
  timeout: 15_000,
}, async () => {
  try {
    const seat = await reserve(primary, 'alice')
    assert.equal(await active(primary), false, 'reserving must not allocate physics')
    const [alice, bob, other] = await Promise.all([
      join(primary, 'alice', seat),
      reserve(primary, 'bob').then((value) => join(primary, 'bob', value)),
      reserve(secondary, 'carol').then((value) => join(secondary, 'carol', value)),
    ])
    await Promise.all([
      observe(
        alice,
        (state) =>
          state.tick > 24 &&
          state.heights.size === 2 &&
          (state.heights.get(bob.sessionId) ?? 3) < 0.7,
        'Alice sees Bob land',
      ),
      observe(
        bob,
        (state) =>
          state.tick > 24 &&
          state.heights.size === 2 &&
          (state.heights.get(alice.sessionId) ?? 3) < 0.7,
        'Bob sees Alice land',
      ),
      observe(
        other,
        (state) =>
          state.tick > 24 &&
          state.heights.size === 1 &&
          (state.heights.get(other.sessionId) ?? 3) < 0.7,
        'Carol lands in the second room',
      ),
    ])
    assert.equal(other.state.heights.has(alice.sessionId), false)
    const hop = observe(
      bob,
      (state) => (state.heights.get(alice.sessionId) ?? 0) > 0.9,
      'Bob sees Alice hop',
    )
    alice.send('hop')
    await hop
    const otherTick = other.state.tick
    await Promise.all([alice.leave(), bob.leave()])
    assert.equal(await active(primary), false, 'last disconnect should stop physics')
    await observe(other, (state) => state.tick > otherTick + 2, 'Second room keeps ticking')
    assert.equal(await active(secondary), true)
    await other.leave()
    assert.equal(await active(secondary), false)
  } finally {
    await Promise.allSettled(
      clients.filter((client) => client.connection.isOpen).map((client) => client.leave()),
    )
  }
})
