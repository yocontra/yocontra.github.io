/**
 * The loopback lobby: stream F's `LobbyCore` (the exact tick, bots, input queues, showdown judge and
 * snapshots the Lobby DO runs, minus sockets, timers and D1) hosted in a worker. Deposits are
 * confirmed locally and touch no wallet. It exists so the client can be developed, demoed and
 * profiled with 31 bots and no account; the protocol is byte-for-byte the real one.
 */
import {
  DEFAULT_TOWN_POPULATION,
  LobbyCore,
  type Session,
} from '../../../../../api/src/town/core.ts'
import { TICK_MS } from '../sim/constants.ts'

export interface LoopbackOptions {
  bots: number
  seed?: number
  name?: string
  banked?: number
  /** Dev perf harness: the bots crowd around you (and leave you be). */
  cluster?: boolean
  /**
   * Dev perf harness: where you first appear (layout metres), instead of the safest spawn. With a
   * fixed `seed` (bots, their spawns and the strongbox all follow the lobby's RNG) every run
   * starts from the same scene, so packed-scene numbers compare.
   */
  spawn?: { x: number; z: number }
}

type Send = (data: Uint8Array | string) => void

export class LoopbackServer {
  private readonly core: LobbyCore
  private readonly send: Send
  private readonly opts: LoopbackOptions
  private session: Session | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private ticks = 0

  constructor(opts: LoopbackOptions, send: Send) {
    this.opts = opts
    this.send = send
    this.core = new LobbyCore('loopback', opts.seed ?? Math.floor(Math.random() * 1e9))
    this.core.botTarget = Math.max(0, opts.bots)
    // `?bots=0` means an empty town, the same as on the dev server.
    this.core.ambientPopulation = opts.bots > 0 ? DEFAULT_TOWN_POPULATION : 0
  }

  start(): void {
    const now = performance.now()
    this.session = this.core.join(
      {
        accountId: 'loopback-you',
        name: this.opts.name ?? 'You',
        level: 7,
        prestige: 0,
        loadout: ['hat.battered-brim', 'outfit.trail-duds'],
        banked: this.opts.banked ?? 0,
        tcpRtt: null,
        ledger: false,
      },
      { send: (d) => this.send(d), close: () => this.stop() },
      now,
    )
    if (this.opts.cluster && this.session) {
      this.core.bots.rally = this.session.playerId
    }
    const you = this.session ? this.core.world.players[this.session.playerId] : null
    if (this.opts.spawn && you) {
      you.x = this.opts.spawn.x
      you.z = this.opts.spawn.z
    }
    this.startedAt = now
    this.timer = setInterval(() => this.pump(), 5)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  receive(data: ArrayBuffer | string): void {
    const s = this.session
    if (!s) {
      return
    }
    if (typeof data === 'string') {
      this.core.onText(s.playerId, data, performance.now())
    } else {
      this.core.onBinary(s.playerId, data, performance.now())
    }
  }

  /** Catch up on every 50 ms tick that has elapsed (setInterval drifts; the sim must not). */
  private pump(): void {
    const now = performance.now()
    const due = Math.floor((now - this.startedAt) / TICK_MS)
    let n = 0
    while (this.ticks < due && n < 4) {
      const out = this.core.tick(now)
      for (const d of out.deposits) {
        this.core.confirmDeposit(d, true)
      }
      this.ticks++
      n++
    }
    if (this.ticks < due) {
      // Way behind (the tab was frozen): drop the backlog rather than spiral.
      this.ticks = due
    }
  }
}
