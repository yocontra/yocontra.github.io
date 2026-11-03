/**
 * Worker host for the loopback lobby. Messages in: `{ kind: 'open', opts, lagMs, jitterMs }`, then
 * raw frames (ArrayBuffer or string) exactly as a WebSocket would carry them. Messages out: raw
 * frames. Optional one-way lag and jitter exercise prediction and reconciliation; delivery stays
 * in order, like TCP.
 */
import { type LoopbackOptions, LoopbackServer } from './loopback-server.ts'

interface OpenMessage {
  kind: 'open'
  opts: LoopbackOptions
  lagMs: number
  jitterMs: number
}

const scope = globalThis as unknown as {
  postMessage: (data: unknown, transfer?: Transferable[]) => void
  onmessage: ((e: MessageEvent) => void) | null
}

let server: LoopbackServer | null = null
let lag = 0
let jitter = 0
let lastOut = 0
let lastIn = 0

/** In-order delivery time with lag and jitter (never earlier than the previous message). */
function due(prev: number): number {
  return Math.max(prev, performance.now() + lag + Math.random() * jitter)
}

function later(at: number, fn: () => void): void {
  const wait = at - performance.now()
  if (wait <= 0) {
    fn()
  } else {
    setTimeout(fn, wait)
  }
}

function out(data: Uint8Array | string): void {
  if (lag <= 0 && jitter <= 0) {
    if (typeof data === 'string') {
      scope.postMessage(data)
    } else {
      scope.postMessage(data.buffer, [data.buffer as ArrayBuffer])
    }
    return
  }
  lastOut = due(lastOut)
  later(lastOut, () => {
    if (typeof data === 'string') {
      scope.postMessage(data)
    } else {
      scope.postMessage(data.buffer, [data.buffer as ArrayBuffer])
    }
  })
}

scope.onmessage = (e: MessageEvent) => {
  const data: unknown = e.data
  if (typeof data === 'object' && data !== null && (data as OpenMessage).kind === 'open') {
    const m = data as OpenMessage
    lag = m.lagMs
    jitter = m.jitterMs
    server?.stop()
    server = new LoopbackServer(m.opts, out)
    server.start()
    return
  }
  if (!(typeof data === 'string' || data instanceof ArrayBuffer)) {
    return
  }
  const s = server
  if (!s) {
    return
  }
  if (lag <= 0 && jitter <= 0) {
    s.receive(data)
    return
  }
  lastIn = due(lastIn)
  later(lastIn, () => s.receive(data))
}
