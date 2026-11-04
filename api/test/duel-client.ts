/** The simulated Bounty Hunt client used by `duel-harness.ts`. */
import process from 'node:process'
import type {
  DuelResult,
  QueueServerMessage,
  RoomClientMessage,
  RoomServerMessage,
} from '../../src/experiments/out-west/contract/duel.ts'

export const BASE = process.argv[2] ?? 'http://localhost:8792'
export const ORIGIN = 'http://localhost:4321'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Player {
  id: string
  name: string
  token: string
  ip: string
}

// --- the simulated client ------------------------------------------------------------------------

export interface Behaviour {
  /** Fire this long after the call (ms), reporting it as localMs. Null never fires. */
  reactMs: number | null
  /** Fire during the wait (cowardice). */
  coward?: boolean
  /** Drop the socket once the walk starts. */
  dropOnWalk?: boolean
  /** Vote for a rematch after the first result, and use `rematchReactMs` then. */
  rematch?: boolean
  rematchReactMs?: number
  /** How long after the first result to vote (default 300 ms). */
  rematchDelayMs?: number
}

export class Client {
  readonly messages: RoomServerMessage[] = []
  readonly results: DuelResult[] = []
  private room: WebSocket | null = null
  matchId = ''
  mode = ''

  readonly player: Player
  private readonly behaviour: Behaviour

  constructor(player: Player, behaviour: Behaviour) {
    this.player = player
    this.behaviour = behaviour
  }

  async queue(opts: { ghostNow?: boolean; leaveAfterMs?: number } = {}): Promise<string | null> {
    const res = await fetch(`${BASE}/queue/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Authorization: `Bearer ${this.player.token}`,
      },
      body: JSON.stringify({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
    })
    const { wsUrl } = (await res.json()) as { wsUrl: string }
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: ORIGIN, 'X-Dev-Ip': this.player.ip },
    } as unknown as string[])
    return await new Promise((resolve) => {
      const timer = opts.leaveAfterMs
        ? setTimeout(() => {
            ws.send(JSON.stringify({ type: 'leave' }))
            resolve(null)
          }, opts.leaveAfterMs)
        : undefined
      ws.addEventListener('message', (event) => {
        const m = JSON.parse(String(event.data)) as QueueServerMessage
        if (m.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', n: m.n }))
        } else if (m.type === 'status' && m.ghostButton && opts.ghostNow) {
          ws.send(JSON.stringify({ type: 'ghost' }))
        } else if (m.type === 'matched') {
          clearTimeout(timer)
          this.matchId = m.matchId
          this.mode = m.mode
          resolve(m.wsUrl)
        } else if (m.type === 'refused' || m.type === 'error') {
          clearTimeout(timer)
          resolve(null)
        }
      })
    })
  }

  private send(m: RoomClientMessage): void {
    try {
      this.room?.send(JSON.stringify(m))
    } catch {
      // closed
    }
  }

  join(wsUrl: string): void {
    const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } } as unknown as string[])
    this.room = ws
    let callAt = 0
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data)) as RoomServerMessage
      this.messages.push(m)
      this.onMessage(
        m,
        () => callAt,
        (t) => {
          callAt = t
        },
      )
    })
  }

  private onMessage(
    m: RoomServerMessage,
    callAt: () => number,
    setCall: (t: number) => void,
  ): void {
    const b = this.behaviour
    switch (m.type) {
      case 'ping':
        this.send({ type: 'pong', n: m.n })
        return
      case 'beat':
        if (m.beat === 'cock') {
          setTimeout(() => this.send({ type: 'ready' }), 100)
        } else if (m.beat === 'walk') {
          if (b.dropOnWalk) {
            this.room?.close()
            return
          }
          this.send({ type: 'hold', down: true })
        } else if (m.beat === 'wait' && b.coward) {
          setTimeout(() => this.send({ type: 'shot', draw: this.drawOf(), localMs: null }), 600)
        }
        return
      case 'call': {
        // the call comes `inMs` ahead of itself: react from when it's presented
        const lead = m.inMs ?? 0
        setCall(performance.now() + lead)
        const react =
          this.results.length > 0 && b.rematchReactMs !== undefined ? b.rematchReactMs : b.reactMs
        if (react !== null) {
          setTimeout(
            () => this.send({ type: 'shot', draw: m.draw, localMs: performance.now() - callAt() }),
            lead + react,
          )
        }
        return
      }
      case 'result':
        this.results.push(m)
        if (b.rematch && this.results.length === 1) {
          setTimeout(() => this.send({ type: 'rematch' }), b.rematchDelayMs ?? 300)
        }
        return
      default:
        return
    }
  }

  /** This client's seat, from the room's hello. */
  get seat(): 0 | 1 {
    const hello = this.messages.find((m) => m.type === 'hello')
    return hello?.type === 'hello' ? hello.you : 0
  }

  private drawOf(): number {
    const sync = [...this.messages].reverse().find((m) => m.type === 'sync')
    return sync?.type === 'sync' ? sync.draw + 1 : 1
  }

  close(): void {
    this.room?.close()
  }
}

/** Poll `pred` every 100 ms until it holds or `timeoutMs` passes; resolves to its final value. */
export async function waitFor(pred: () => boolean, timeoutMs = 40_000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  const poll = async (): Promise<boolean> => {
    if (pred()) {
      return true
    }
    if (Date.now() >= end) {
      return pred()
    }
    await sleep(100)
    return poll()
  }
  return await poll()
}
