import type { ServerControl } from '../contract/town.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import type { FrontierSession } from './frontier-session.ts'

type ConnectionState = 'open' | 'retrying' | 'closed'
/** A fresh authenticated reservation replaces expired join tickets after a disconnect. */
export async function reconnectableSession(
  connect: (onState: (state: ConnectionState, reason?: string) => void) => Promise<FrontierSession>,
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
  const handle = (state: ConnectionState, reason?: string): void => {
    if (lifecycle.signal.aborted) {
      return
    }
    if (state === 'open') {
      if (!retrying) {
        onState?.(state)
      }
      return
    }
    if (!retrying) {
      void reconnect(reason)
    }
  }
  let active = await connect(handle)
  forward(active)
  async function reconnect(reason?: string): Promise<void> {
    retrying = true
    snapshot = new Map(active.players)
    active.dispose()
    onState?.('retrying', reason)
    let failure = reason
    for (const delay of [0, 500, 1500]) {
      if (lifecycle.signal.aborted) {
        return
      }
      if (delay > 0) {
        // biome-ignore lint/performance/noAwaitInLoops: reservations retry sequentially with bounded backoff
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      if (lifecycle.signal.aborted) {
        return
      }
      try {
        const replacement = await connect(handle)
        if (lifecycle.signal.aborted) {
          replacement.dispose()
          return
        }
        active = replacement
        forward(active)
        retrying = false
        onState?.('open')
        return
      } catch (error) {
        failure = error instanceof Error ? error.message : 'Could not reconnect.'
      }
    }
    onState?.('closed', failure)
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
