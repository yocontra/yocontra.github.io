import { expect, test as it, setSystemTime } from 'bun:test'
import { CloudflareClient } from '../../api/src/game/socket.ts'
import {
  batchInputs,
  packPackets,
  unpackPackets,
} from '../../src/experiments/out-west/runtime/packets.ts'

it('batches only native reliable input packets, rejects truncation and trailing data', () => {
  const first = new Uint8Array([19, 1, 2])
  const second = new Uint8Array([19 | 64, 3])
  const packed = packPackets([first, second])
  expect(unpackPackets(packed).map((packet) => [...packet])).toEqual([
    [19, 1, 2],
    [83, 3],
  ])
  expect(() => unpackPackets(packed.subarray(0, -1))).toThrow()
  expect(() => unpackPackets(new Uint8Array([...packed, 0]))).toThrow()
  expect(() => unpackPackets(packPackets([new Uint8Array([13, 0])]))).toThrow('Only input')
  expect(() => packPackets([])).toThrow()
  expect(() => unpackPackets(new Uint8Array(5000))).toThrow()
})
it('copies SDK input bytes before buffer reuse, sends two at once and bypasses controls', () => {
  const sent: Uint8Array[] = []
  const connection = {
    send: (packet: Uint8Array) => {
      sent.push(Uint8Array.from(packet))
    },
  }
  const batching = batchInputs(connection)
  const input = new Uint8Array([19, 1])
  connection.send(input)
  input[1] = 2
  connection.send(input)
  expect(sent).toHaveLength(1)
  expect(unpackPackets(sent[0] ?? new Uint8Array()).map((packet) => [...packet])).toEqual([
    [19, 1],
    [19, 2],
  ])
  connection.send(new Uint8Array([13, 1]))
  expect(sent[1]).toEqual(new Uint8Array([13, 1]))
  batching.dispose()
  connection.send(input)
  expect(sent[2]).toEqual(input)
})
it('limits outer WebSocket messages on wall time, tolerating a stalled backlog', () => {
  setSystemTime(new Date(1_000_000))
  try {
    const closes: { code: number; reason: string }[] = []
    const socket = {
      readyState: 1,
      close: (code: number, reason: string) => closes.push({ code, reason }),
    } as unknown as WebSocket
    const client = new CloudflareClient('a', socket)
    let messages = 0
    client.on('message', () => {
      messages++
    })
    const packet = Uint8Array.from(packPackets([new Uint8Array([19]), new Uint8Array([19])])).buffer
    // three seconds of 20 Hz input pairs arriving at once after a hitch
    for (let i = 0; i < 60; i++) {
      client.dispatch(packet)
    }
    expect(messages).toBe(120)
    expect(closes).toEqual([])
    // sustained play at the normal rate keeps refilling
    for (let second = 1; second <= 10; second++) {
      setSystemTime(new Date(1_000_000 + second * 1000))
      for (let i = 0; i < 10; i++) {
        client.dispatch(packet)
      }
    }
    expect(closes).toEqual([])
    // a flood beyond the sustained rate still closes
    for (let i = 0; i < 80 && closes.length === 0; i++) {
      client.dispatch(packet)
    }
    expect(closes[0]?.code).toBe(1008)
  } finally {
    setSystemTime()
  }
})
