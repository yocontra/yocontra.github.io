/** Tiny transport envelope: native Colyseus packets remain unmodified and independently decoded. */
import { Protocol } from '@colyseus/shared-types'

const BATCH = 254
const MAX_PACKET = 2048
export function packPackets(packets: readonly Uint8Array[]): Uint8Array {
  if (
    packets.length === 0 ||
    packets.length > 2 ||
    packets.some((packet) => packet.length === 0 || packet.length > MAX_PACKET)
  ) {
    throw new Error('Invalid packet batch')
  }
  const output = new Uint8Array(2 + packets.reduce((size, packet) => size + 2 + packet.length, 0))
  output[0] = BATCH
  output[1] = packets.length
  const view = new DataView(output.buffer)
  let offset = 2
  for (const packet of packets) {
    view.setUint16(offset, packet.length)
    offset += 2
    output.set(packet, offset)
    offset += packet.length
  }
  return output
}
export function unpackPackets(data: Uint8Array): readonly Uint8Array[] {
  if (data.length > MAX_PACKET * 2 + 6) {
    throw new Error('Packet too large')
  }
  if (data[0] !== BATCH) {
    return [data]
  }
  const count = data[1]
  if (count !== 1 && count !== 2) {
    throw new Error('Invalid packet count')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const packets: Uint8Array[] = []
  let offset = 2
  for (let i = 0; i < count; i++) {
    if (offset + 2 > data.length) {
      throw new Error('Truncated packet length')
    }
    const length = view.getUint16(offset)
    offset += 2
    if (!length || length > MAX_PACKET || offset + length > data.length) {
      throw new Error('Invalid packet length')
    }
    const packet = data.subarray(offset, offset + length)
    if (((packet[0] ?? 0) & 63) !== Protocol.ROOM_INPUT_RELIABLE) {
      throw new Error('Only input packets may be batched')
    }
    packets.push(packet)
    offset += length
  }
  if (offset !== data.length) {
    throw new Error('Trailing packet bytes')
  }
  return packets
}
export interface PacketConnection {
  send: (data: Uint8Array) => void
}
/** Two20Hz input packets travel in one10Hz WebSocket message. Handshakes/control bypass batching. */
export function batchInputs(connection: PacketConnection) {
  const send = connection.send
  let queue: Uint8Array[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  function flush() {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    timer = undefined
    if (queue.length > 0) {
      const packet = packPackets(queue)
      queue = []
      send.call(connection, packet)
    }
  }
  connection.send = (packet) => {
    if (((packet[0] ?? 0) & 63) !== Protocol.ROOM_INPUT_RELIABLE) {
      send.call(connection, packet)
      return
    }
    queue.push(Uint8Array.from(packet))
    if (queue.length === 2) {
      flush()
    } else {
      timer = setTimeout(flush, 100)
    }
  }
  return {
    flush,
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      queue = []
      connection.send = send
    },
  }
}
