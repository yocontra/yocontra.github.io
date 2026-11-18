import { type ServerControl, TOWN_CLOSE_REPLACED } from '../contract/town.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import type { FrontierSession } from './frontier-session.ts'

type ConnectionState = 'open' | 'retrying' | 'closed'
export type ConnectionNotice = (state: ConnectionState, reason?: string, code?: number) => void

class EarlyDisconnect extends Error {
  readonly code: number | undefined
  constructor(message: string, code: number | undefined) {
    super(message)
    this.code = code
  }
}
/** A fresh authenticated reservation replaces expired join tickets after a disconnect. */
export async function reconnectableSession(
  connect: (onState: ConnectionNotice) => Promise<FrontierSession>,
  onState?: (state: ConnectionState, reason?: string) => void,
): Promise<FrontierSession> {
  const lifecycle = new AbortController()
  const events = new Set<(event: SimEvent) => void>()
  const controls = new Set<(control: ServerControl) => void>()
  let retrying = false
  let snapshot = new Map<string, PlayerState>()
  const forward = (session: FrontierSession): void => {
    session.subscribe((event) => {
      for (const listener of events) {
        listener(event)
      }
    })
    session.subscribeControl((control) => {
      for (const listener of controls) {
        listener(control)
      }
    })
  }
  const handle: ConnectionNotice = (state, reason, code) => {
    if (lifecycle.signal.aborted || retrying || state === 'open') {
      return
    }
    retrying = true
    snapshot = new Map(active.players)
    active.dispose()
    if (code === TOWN_CLOSE_REPLACED) {
      onState?.('closed', reason ?? 'Joined from somewhere else.')
      return
    }
    void reconnect(reason)
  }
  async function attempt() {
    let early: EarlyDisconnect | undefined
    let listener: ConnectionNotice | undefined
    const session = await connect((state, reason, code) => {
      if (listener) {
        listener(state, reason, code)
      } else if (state !== 'open') {
        early = new EarlyDisconnect(reason ?? 'Connection lost.', code)
      }
    })
    if (early) {
      session.dispose()
      throw early
    }
    return {
      session,
      listen: () => {
        listener = (state, reason, code) => {
          if (active === session) {
            handle(state, reason, code)
          }
        }
      },
    }
  }
  const initial = await attempt()
  let active = initial.session
  forward(active)
  initial.listen()
  onState?.('open')
  async function reconnect(reason?: string): Promise<void> {
    onState?.('retrying', reason)
    let failure = reason
    for (const delay of [0, 500, 1500]) {
      if (delay > 0) {
        // biome-ignore lint/performance/noAwaitInLoops: reservations retry sequentially with bounded backoff
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      if (lifecycle.signal.aborted) {
        return
      }
      try {
        const replacement = await attempt()
        if (lifecycle.signal.aborted) {
          replacement.session.dispose()
          return
        }
        active = replacement.session
        forward(active)
        replacement.listen()
        retrying = false
        onState?.('open')
        return
      } catch (error) {
        failure = error instanceof Error ? error.message : 'Could not reconnect.'
        if (error instanceof EarlyDisconnect && error.code === TOWN_CLOSE_REPLACED) {
          break
        }
      }
    }
    if (!lifecycle.signal.aborted) {
      onState?.('closed', failure)
    }
  }
  return {
    get selfId() {
      return active.selfId
    },
    get selfSlot() {
      return active.selfSlot
    },
    get world() {
      return active.world
    },
    get banked() {
      return active.banked
    },
    get lobbyId() {
      return active.lobbyId
    },
    practice: false,
    get players() {
      return retrying ? snapshot : active.players
    },
    appearance: (id) => active.appearance?.(id),
    subscribe(listener) {
      events.add(listener)
      return () => events.delete(listener)
    },
    subscribeControl(listener) {
      controls.add(listener)
      return () => controls.delete(listener)
    },
    control(text) {
      if (!retrying) {
        active.control(text)
      }
    },
    update(dt, input) {
      if (!(retrying || lifecycle.signal.aborted)) {
        active.update(dt, input)
      }
    },
    cameraTrace(from, to) {
      return retrying ? null : (active.cameraTrace?.(from, to) ?? null)
    },
    dispose() {
      if (lifecycle.signal.aborted) {
        return
      }
      lifecycle.abort()
      events.clear()
      controls.clear()
      active.dispose()
    },
  }
}
