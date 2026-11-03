/**
 * One duplex pipe to a lobby, whichever lobby it is: the real Lobby DO over a reconnecting
 * WebSocket (`POST /town/join` → `wsUrl` with a single-use ticket), or the loopback lobby in a
 * worker. Both carry the same frames: binary inputs and snapshots, JSON control text.
 */
import type { TownJoinRefusal, TownJoinRequest, TownJoinResponse } from '../../contract/town.ts'
import { API_URL, getAccessToken } from '../../net/auth.ts'
import { openReconnecting, type ReconnectingSocket } from '../../platform/reconnect.ts'
import type { LoopbackOptions } from './loopback-server.ts'

export type TransportState = 'connecting' | 'open' | 'retrying' | 'closed'

export interface TransportEvents {
  onMessage: (data: ArrayBuffer | string) => void
  onState: (state: TransportState, detail?: string) => void
  /** A reconnect: the next snapshot is a full one and the delta baseline must be dropped. */
  onReopen: () => void
}

export interface Transport {
  readonly kind: 'loopback' | 'remote'
  send: (data: Uint8Array | string) => void
  close: () => void
}

export interface LoopbackTransportOptions extends LoopbackOptions {
  lagMs?: number
  jitterMs?: number
}

export function openLoopback(opts: LoopbackTransportOptions, ev: TransportEvents): Transport {
  const worker = new Worker(new URL('./loopback.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<ArrayBuffer | string>) => ev.onMessage(e.data)
  worker.onerror = (e) => ev.onState('closed', e.message || 'loopback crashed')
  const { lagMs = 0, jitterMs = 0, ...server } = opts
  worker.postMessage({ kind: 'open', opts: server, lagMs, jitterMs })
  queueMicrotask(() => ev.onState('open'))
  return {
    kind: 'loopback',
    send: (data) => {
      if (typeof data === 'string') {
        worker.postMessage(data)
      } else {
        const copy = data.slice().buffer
        worker.postMessage(copy, [copy])
      }
    },
    close: () => {
      worker.postMessage(JSON.stringify({ type: 'bye' }))
      setTimeout(() => worker.terminate(), 50)
      ev.onState('closed')
    },
  }
}

/** Why a join failed, in words a player should see. */
export interface JoinError {
  reason: TownJoinRefusal | 'network' | 'server'
  message: string
}

export const JOIN_MESSAGES: Record<JoinError['reason'], string> = {
  over_budget: 'Perdition is closed until next month. Quick Draw is still open.',
  all_full: 'Every town is full. Try again in a minute.',
  unauthorized: 'Sign in with your passkey to ride into Perdition.',
  unlicensed: 'Beat the first 3 outlaws on a ranked run to earn your licence.',
  network: "Can't reach the frontier. Check your connection.",
  server: 'Server trouble in Perdition. Try again in a few minutes.',
}

const REFUSALS = new Set<string>(['over_budget', 'all_full', 'unauthorized', 'unlicensed'])

export type JoinResult = { ok: true; value: TownJoinResponse } | { ok: false; error: JoinError }

export async function joinTown(
  req: TownJoinRequest,
  apiUrl = API_URL,
  getToken: () => Promise<string | null> = getAccessToken,
): Promise<JoinResult> {
  const token = await getToken()
  if (!token) {
    return { ok: false, error: { reason: 'unauthorized', message: JOIN_MESSAGES.unauthorized } }
  }
  let res: Response
  try {
    res = await fetch(`${apiUrl}/town/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
  } catch {
    return { ok: false, error: { reason: 'network', message: JOIN_MESSAGES.network } }
  }
  const body = (await res.json().catch(() => null)) as
    | (Partial<TownJoinResponse> & { reason?: string; error?: string })
    | null
  if (res.ok && body?.wsUrl && body.lobbyId) {
    return {
      ok: true,
      value: { wsUrl: body.wsUrl, lobbyId: body.lobbyId, players: body.players ?? 0 },
    }
  }
  const reason = body?.reason && REFUSALS.has(body.reason) ? body.reason : null
  if (reason) {
    const r = reason as TownJoinRefusal
    // The server's own words win (e.g. when the town reopens).
    const message =
      typeof body?.error === 'string' && body.error.length > 12 ? body.error : JOIN_MESSAGES[r]
    return { ok: false, error: { reason: r, message } }
  }
  if (res.status === 401) {
    return { ok: false, error: { reason: 'unauthorized', message: JOIN_MESSAGES.unauthorized } }
  }
  return { ok: false, error: { reason: 'server', message: body?.error ?? JOIN_MESSAGES.server } }
}

export interface RemoteOptions {
  apiUrl?: string
  lobbyId?: string
  bots?: number
  /** Access token source (defaults to the passkey session). */
  getToken?: () => Promise<string | null>
  /** A join refusal on the first attempt (full, budget, auth). */
  onRefused: (e: JoinError) => void
}

/** The real lobby: join, then a WebSocket that rejoins (fresh ticket) after network switches. */
export function openRemote(opts: RemoteOptions, ev: TransportEvents): Transport {
  let lobbyId = opts.lobbyId
  let attempts = 0
  const socket: ReconnectingSocket = openReconnecting({
    binaryType: 'arraybuffer',
    // Snapshots arrive at 20 Hz: half a second of silence is already a dead socket.
    staleMs: 1500,
    url: async () => {
      const req: TownJoinRequest = {}
      if (lobbyId) {
        req.lobbyId = lobbyId
      }
      if (opts.bots !== undefined && attempts === 0) {
        req.bots = opts.bots
      }
      attempts++
      const r = await joinTown(req, opts.apiUrl, opts.getToken)
      if (!r.ok) {
        const transient = r.error.reason === 'network' || r.error.reason === 'server'
        if (attempts > 1 && transient) {
          // offline mid-switch, or the Worker hiccuped: throwing makes the socket retry with
          // backoff (returning null would give up on the first failed rejoin)
          throw new Error(r.error.message)
        }
        opts.onRefused(r.error)
        return null
      }
      lobbyId = r.value.lobbyId
      return r.value.wsUrl
    },
    onOpen: (attempt) => {
      if (attempt > 0) {
        ev.onReopen()
      }
      ev.onState('open')
    },
    onMessage: (data) => ev.onMessage(data),
    onDrop: (reason) => ev.onState('retrying', reason),
    onGiveUp: (reason) => ev.onState('closed', reason),
  })
  return {
    kind: 'remote',
    send: (data) => {
      socket.send(typeof data === 'string' ? data : (data.slice().buffer as ArrayBuffer))
    },
    close: () => {
      socket.send(JSON.stringify({ type: 'bye' }))
      socket.close(1000, 'bye')
      ev.onState('closed')
    },
  }
}
