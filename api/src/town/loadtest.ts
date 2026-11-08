/** Real SDK load against the isolated, fully authenticated local production fixture.
 * Run fixture Wrangler config on8792, then: bun api/src/town/loadtest.ts [url] [clients=3] [seconds=30]
 * Accounts come from the local fixture's D1 seeder and normal signed JWT; all public join guards run.
 */
import { argv, stdout } from 'node:process'
import { Client, type Room } from '@colyseus/sdk'
import { COLLISION_VERSION } from '../../../src/experiments/out-west/content/manifest.ts'
import { TOWN_WIRE_VERSION } from '../../../src/experiments/out-west/contract/town.ts'
import { batchInputs } from '../../../src/experiments/out-west/runtime/packets.ts'
import { PROTOCOL_VERSION } from '../../../src/experiments/out-west/runtime/protocol.ts'
import { FrontierState, MoveInput } from '../../../src/experiments/out-west/runtime/schema.ts'

const base = argv[2] ?? 'http://127.0.0.1:8792'
const url = new URL(base)
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  throw new Error('Use the isolated localhost fixture')
}
const origin = 'http://127.0.0.1:4390'
const count = Math.min(32, Math.max(1, Number(argv[3] ?? 3)))
const seconds = Math.min(300, Math.max(1, Number(argv[4] ?? 30)))
interface Rider {
  room: Room<unknown, FrontierState>
  stop: () => void
  outgoing: number
  bytes: number
  updates: number
  shots: number
}
async function joinRider(index: number): Promise<Rider> {
  const account = (await (await fetch(`${base}/__test/seed`)).json()) as { token: string }
  const response = await fetch(`${base}/town/join`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${account.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      wire: TOWN_WIRE_VERSION,
      protocol: PROTOCOL_VERSION,
      collision: COLLISION_VERSION,
      turnstileToken: 'official-local-provider-test',
    }),
  })
  const seat = (await response.json()) as {
    lobbyId: string
    wsUrl: string
    reservation: Parameters<Client['consumeSeatReservation']>[0]
    error?: string
  }
  if (!response.ok) {
    throw new Error(seat.error ?? `Join failed:${response.status}`)
  }
  const client = new Client(`${base}/town/${seat.lobbyId}?${new URL(seat.wsUrl).searchParams}`, {
    headers: { Origin: origin },
  })
  const room: Room<unknown, FrontierState> = await client.consumeSeatReservation(
    seat.reservation,
    FrontierState,
  )
  room.reconnection.enabled = false
  const result: Rider = { room, stop: () => undefined, outgoing: 0, bytes: 0, updates: 0, shots: 0 }
  const send = room.connection.send.bind(room.connection)
  room.connection.send = (packet: Uint8Array) => {
    result.outgoing++
    result.bytes += packet.byteLength
    send(packet)
  }
  const batching = batchInputs(room.connection)
  const input = room.input({ type: MoveInput, mode: 'reliable' })
  room.onMessage('control', () => undefined)
  room.onMessage('events', (message: { events: { type: string }[] }) => {
    result.shots += message.events.filter((event) => event.type === 'shot').length
  })
  room.onStateChange(() => {
    result.updates++
  })
  let seq = 0
  const timer = setInterval(() => {
    const phase = Math.floor(seq / 100) % 3
    Object.assign(input.data, {
      seq: ++seq,
      moveX: phase === 2 ? 0 : Math.sin(seq / 40 + index),
      moveZ: phase === 2 ? 0 : Math.cos(seq / 40 + index),
      yaw: seq / 30,
      pitch: 0,
      buttons: phase === 0 && seq % 10 === 0 ? 1 : 0,
      viewTime: Math.max(0, room.state.tick - 2),
    })
    input.send()
  }, 50)
  result.stop = () => {
    clearInterval(timer)
    batching.dispose()
  }
  return result
}
const riders: Rider[] = []
try {
  const joined = await Promise.allSettled(
    Array.from({ length: count }, (_, index) => joinRider(index)),
  )
  for (const result of joined) {
    if (result.status === 'fulfilled') {
      riders.push(result.value)
    } else {
      throw result.reason
    }
  }
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  stdout.write(
    `${JSON.stringify({ clients: riders.length, seconds, clientsMeasured: riders.map((rider) => ({ tick: rider.room.state.tick, players: rider.room.state.players.size, updates: rider.updates, observedShots: rider.shots, outgoingMessagesPerSecond: rider.outgoing / seconds, outgoingBytesPerSecond: rider.bytes / seconds })) }, null, 2)}\n`,
  )
} finally {
  for (const rider of riders) {
    rider.stop()
  }
  await Promise.all(riders.map((rider) => rider.room.leave()))
}
