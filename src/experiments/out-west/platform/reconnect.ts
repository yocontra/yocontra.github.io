/**
 * A WebSocket that survives Wi-Fi ↔ cellular switches (spec §11.1).
 *
 * A network switch kills the TCP socket, often silently. The socket is declared dead when **no
 * message arrives for `staleMs`** (default 1.5 s; servers ping every 400 ms), or when the browser
 * reports `offline`, `online` or a `navigator.connection` change. It then reconnects with backoff
 * (0.25, 0.5, 1, 2 s, then 2 s repeating) until `deadlineMs` of continuous failure.
 *
 * `url()` runs before every attempt, so each attempt can fetch a fresh single-use ticket (or a
 * resume ticket) from `POST /tickets`. Pure transport: game semantics (grace periods, snapshots on
 * rejoin) belong to the caller. Owned by stream A.
 */

export type ReconnectState = 'connecting' | 'open' | 'retrying' | 'closed'

export interface ReconnectOptions {
  /** A fresh URL (with a fresh ticket) for each attempt; null gives up. */
  url: () => Promise<string | null>
  /** `attempt` is 0 for the first connection and counts up for reconnects. */
  onOpen?: (attempt: number) => void
  onMessage: (data: string | ArrayBuffer) => void
  /** The connection was lost and a retry is scheduled. */
  onDrop?: (reason: string) => void
  /** No more retries: `close()` was not called, but the deadline passed or `url()` gave up. */
  onGiveUp?: (reason: string) => void
  staleMs?: number
  backoffMs?: readonly number[]
  deadlineMs?: number
  binaryType?: BinaryType
  /** Close codes after which retrying is pointless (e.g. the match ended). Default 1000, 4000–4099. */
  isFinal?: (code: number) => boolean
  /** Injectable for tests. */
  createSocket?: (url: string) => WebSocket
}

export interface ReconnectingSocket {
  readonly state: ReconnectState
  /** Sends if open; returns false otherwise (callers decide whether to queue). */
  send: (data: Parameters<WebSocket['send']>[0]) => boolean
  /** Closes for good; no callbacks fire after this. */
  close: (code?: number, reason?: string) => void
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000]
const DEFAULT_STALE_MS = 1500
const DEFAULT_DEADLINE_MS = 30_000
const STALE_CHECK_MS = 250

const defaultFinal = (code: number): boolean => code === 1000 || (code >= 4000 && code < 4100)

/** Delay before reconnect attempt `n` (1-based). The last backoff step repeats. */
export function backoffDelay(n: number, steps: readonly number[] = DEFAULT_BACKOFF_MS): number {
  return steps[Math.min(Math.max(n, 1), steps.length) - 1] ?? 0
}

interface NetworkInformationLike extends EventTarget {
  readonly type?: string
}

function connection(): NetworkInformationLike | null {
  const c: unknown = typeof navigator === 'undefined' ? null : Reflect.get(navigator, 'connection')
  return c instanceof EventTarget ? (c as NetworkInformationLike) : null
}

export function openReconnecting(opts: ReconnectOptions): ReconnectingSocket {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const steps = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const isFinal = opts.isFinal ?? defaultFinal
  const create = opts.createSocket ?? ((u: string) => new WebSocket(u))

  let state: ReconnectState = 'connecting'
  let ws: WebSocket | null = null
  let attempt = 0
  let failures = 0
  let failingSince = 0
  let lastMessage = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let staleTimer: ReturnType<typeof setInterval> | null = null

  const detach = (): void => {
    if (staleTimer !== null) {
      clearInterval(staleTimer)
      staleTimer = null
    }
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        // already closing
      }
      ws = null
    }
  }

  const removeNetworkListeners = (): void => {
    globalThis.removeEventListener?.('online', onNetworkChange)
    globalThis.removeEventListener?.('offline', onNetworkChange)
    connection()?.removeEventListener('change', onNetworkChange)
  }

  const giveUp = (reason: string): void => {
    if (state === 'closed') {
      return
    }
    state = 'closed'
    detach()
    removeNetworkListeners()
    opts.onGiveUp?.(reason)
  }

  const schedule = (reason: string, immediate = false): void => {
    if (state === 'closed' || retryTimer !== null) {
      return
    }
    const wasOpen = state === 'open'
    detach()
    state = 'retrying'
    failures += 1
    failingSince ||= Date.now()
    if (Date.now() - failingSince > deadlineMs) {
      giveUp(`couldn’t reconnect: ${reason}`)
      return
    }
    if (wasOpen) {
      opts.onDrop?.(reason)
    }
    const delay = immediate ? 0 : backoffDelay(failures, steps)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect()
    }, delay)
  }

  function onNetworkChange(): void {
    if (state === 'closed') {
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Nothing will work until we're back online; drop now so the caller can show "reconnecting".
      if (state === 'open') {
        schedule('offline')
      }
      return
    }
    // A new network (or back online): the old socket is likely dead, so try again right away.
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
      void connect()
    } else if (state === 'open') {
      schedule('network changed', true)
    }
  }

  async function connect(): Promise<void> {
    if (state === 'closed') {
      return
    }
    state = state === 'retrying' ? 'retrying' : 'connecting'
    let url: string | null
    try {
      url = await opts.url()
    } catch {
      schedule('couldn’t get a ticket')
      return
    }
    if ((state as ReconnectState) === 'closed') {
      return
    }
    if (url === null) {
      giveUp('no ticket')
      return
    }
    const socket = create(url)
    ws = socket
    socket.binaryType = opts.binaryType ?? 'arraybuffer'
    socket.onopen = () => {
      state = 'open'
      failures = 0
      failingSince = 0
      lastMessage = Date.now()
      staleTimer = setInterval(() => {
        if (Date.now() - lastMessage > staleMs) {
          schedule('no messages')
        }
      }, STALE_CHECK_MS)
      opts.onOpen?.(attempt)
      attempt += 1
    }
    socket.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      lastMessage = Date.now()
      opts.onMessage(e.data)
    }
    socket.onclose = (e: CloseEvent) => {
      if (isFinal(e.code)) {
        giveUp(e.reason || 'closed')
      } else {
        schedule(e.reason || `closed (${e.code})`)
      }
    }
    socket.onerror = () => schedule('socket error')
  }

  globalThis.addEventListener?.('online', onNetworkChange)
  globalThis.addEventListener?.('offline', onNetworkChange)
  connection()?.addEventListener('change', onNetworkChange)
  void connect()

  return {
    get state() {
      return state
    },
    send(data) {
      if (state !== 'open' || ws?.readyState !== WebSocket.OPEN) {
        return false
      }
      ws.send(data)
      return true
    },
    close(code = 1000, reason = 'bye') {
      if (state === 'closed') {
        return
      }
      state = 'closed'
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      const socket = ws
      ws = null
      detach()
      removeNetworkListeners()
      try {
        socket?.close(code, reason)
      } catch {
        // already closed
      }
    },
  }
}
