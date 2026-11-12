/** Independently authored Colyseus 0.18 Client/ClientPrivate adapter over DO-owned sockets.
 * Community feasibility research: c-py/colyseus-cloudflare-worker-transport
 * b0f296e444867dc2edb47e351c28b7238e08289f (UNLICENSED; no source incorporated).
 * Protocol encoding and outgoing queue semantics come from official @colyseus/core.
 */

import { EventEmitter } from 'node:events'
import {
  type Client,
  type ClientPrivate,
  ClientState,
  enqueueClientRaw,
  getMessageBytes,
  type ISendOptions,
  Protocol,
} from '@colyseus/core'
import { unpackPackets } from '../../../src/experiments/out-west/runtime/packets.ts'

/** Sustained frames per second, each carrying at most two SDK packets. */
const FRAME_RATE = 20
/** A stalled tab or radio delivers its queued frames at once; three seconds of backlog is play. */
const FRAME_BURST = FRAME_RATE * 3
export class CloudflareClient extends EventEmitter implements Client, ClientPrivate {
  declare '~messages': Record<string | number, unknown>
  readonly ref = this
  readonly sessionId: string
  readonly ws: WebSocket
  state: ClientState = ClientState.JOINING
  reconnectionToken = ''
  _enqueuedMessages: Uint8Array[] = []
  _joinedAt = 0
  private frameTokens = FRAME_BURST
  private refilledAt = Date.now()
  private readonly delivered: (bytes: number) => void
  constructor(
    sessionId: string,
    ws: WebSocket,
    delivered: (bytes: number) => void = () => undefined,
  ) {
    super()
    this.sessionId = sessionId
    this.ws = ws
    this.delivered = delivered
  }
  get readyState() {
    return this.ws.readyState
  }
  raw(data: Uint8Array, _options?: ISendOptions, cb?: (error?: Error) => void) {
    try {
      this.ws.send(Uint8Array.from(data))
      this.delivered(data.byteLength)
      cb?.()
    } catch (error) {
      cb?.(error instanceof Error ? error : new Error(String(error)))
      this.ws.close(1011, 'Connection unavailable')
    }
  }
  enqueueRaw(data: Uint8Array, options?: ISendOptions) {
    enqueueClientRaw(this, data, options)
  }
  send(type: string | number | symbol, message?: unknown, options?: ISendOptions) {
    if (typeof type === 'symbol') {
      throw new Error('Symbol message type unsupported')
    }
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA, type, message), options)
  }
  sendBytes(type: string | number, bytes: Uint8Array, options?: ISendOptions) {
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA_BYTES, type, undefined, bytes), options)
  }
  leave(code = 1000, reason = '') {
    this.ws.close(code, reason)
  }
  close(code = 1000, reason = '') {
    this.leave(code, reason)
  }
  error(code: number, message = '') {
    this.raw(getMessageBytes[Protocol.ERROR](code, message))
  }
  dispatch(data: ArrayBuffer | string) {
    const now = Date.now()
    this.frameTokens = Math.min(
      FRAME_BURST,
      this.frameTokens + (Math.max(0, now - this.refilledAt) * FRAME_RATE) / 1000,
    )
    this.refilledAt = now
    if (this.frameTokens < 1) {
      this.leave(1008, 'Message rate exceeded')
      return
    }
    this.frameTokens--
    if (typeof data === 'string') {
      this.leave(1003, 'Binary frames required')
      return
    }
    try {
      const packets = unpackPackets(new Uint8Array(data))
      // The timestamp is observed on incoming I/O, unlike a quiet Workers timer clock.
      this.emit('activity', now)
      for (const packet of packets) {
        this.emit('message', packet)
      }
    } catch {
      this.leave(1009, 'Invalid frame')
    }
  }
  disconnected(code: number, reason: string) {
    this.emit('close', code, reason)
  }
}
