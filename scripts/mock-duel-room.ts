// biome-ignore-all lint/style/noNestedTernary: a throwaway dev mock; terse tables over ceremony
/**
 * A tiny in-memory DuelRoom for testing the Bounty Hunt client (stream D) before the real Worker
 * is merged. It speaks `contract/duel.ts` and follows its beat sheet: intro, cock (both ready),
 * the walk (a pace every 500 ms while both hold; heckle at 6 s, auto-walk at 10 s), the turn, the
 * wait with 0–2 fake-out cues, the call, judging, dead heats with sudden death, the result and the
 * rematch window. A ghost seat plays itself. Started by `scripts/mock-api.ts`.
 */
import type { ServerWebSocket } from 'bun'
import {
  type Beat,
  type DuelResult,
  type MatchOutcome,
  PACE_MS,
  type Poster,
  PVP_CUES,
  REMATCH_WINDOW_MS,
  type RoomClientMessage,
  type RoomServerMessage,
  type Seat,
  type Settlement,
} from '../src/experiments/out-west/contract/duel.ts'

export interface SeatSocket {
  ws: ServerWebSocket<unknown> | null
  ready: boolean
  holding: boolean
  shot: number | null
  shotSeen: boolean
  ghost: boolean
  /** Ghost reaction (ms). */
  draws: number
}

export interface Settle {
  settle: (seat: Seat, won: boolean | null, outcome: MatchOutcome, ms: number | null) => Settlement
}

const between = (a: number, b: number): number => a + Math.random() * (b - a)
const other = (s: Seat): Seat => (s === 0 ? 1 : 0)

/** Mock knobs (env): MOCK_DEADHEAT=1 makes the ghost match your first draw exactly, once. */
const FORCE_DEAD_HEAT = process.env.MOCK_DEADHEAT === '1'

export class MockRoom {
  readonly id: string
  readonly posters: readonly [Poster, Poster]
  readonly mode: 'pvp' | 'ghost'
  readonly seats: [SeatSocket, SeatSocket]
  private beat: Beat = 'intro'
  private deadline: number | null = null
  private pace = 0
  private paces = 7
  private draw = 0
  private deadHeats = 0
  private rematches = 0
  private callAt = 0
  private stallMs = 0
  private last: DuelResult | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private walkTimer: ReturnType<typeof setInterval> | null = null
  private readonly pingTimer: ReturnType<typeof setInterval>
  private votes: [boolean, boolean] = [false, false]
  private forcedOnce = false as boolean
  private readonly econ: Settle

  constructor(
    id: string,
    posters: readonly [Poster, Poster],
    ghostSeat: Seat | null,
    econ: Settle,
  ) {
    this.id = id
    this.posters = posters
    this.mode = ghostSeat === null ? 'pvp' : 'ghost'
    const seat = (ghost: boolean): SeatSocket => ({
      ws: null,
      ready: ghost,
      holding: false,
      shot: null,
      shotSeen: false,
      ghost,
      draws: Math.round(between(215, 300)),
    })
    this.seats = [seat(ghostSeat === 0), seat(ghostSeat === 1)]
    this.econ = econ
    let n = 0
    this.pingTimer = setInterval(() => this.broadcast({ type: 'ping', n: n++ }), 400)
  }

  private send(s: Seat, m: RoomServerMessage): void {
    this.seats[s].ws?.send(JSON.stringify(m))
  }

  private broadcast(m: RoomServerMessage): void {
    this.send(0, m)
    this.send(1, m)
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms))
  }

  private clear(): void {
    for (const t of this.timers) {
      clearTimeout(t)
    }
    this.timers = []
    if (this.walkTimer) {
      clearInterval(this.walkTimer)
      this.walkTimer = null
    }
  }

  private setBeat(beat: Beat, forMs: number | null): void {
    this.beat = beat
    this.deadline = forMs === null ? null : Date.now() + forMs
    this.broadcast({ type: 'beat', serverTime: Date.now(), beat, deadline: this.deadline })
  }

  /** A seat's socket opened (first time or a reconnect). */
  join(seat: Seat, ws: ServerWebSocket<unknown>): void {
    const rejoin = this.seats[seat].ws !== null || this.beat !== 'intro'
    this.seats[seat].ws = ws
    this.hello(seat)
    if (rejoin) {
      this.send(other(seat), { type: 'presence', seat, connected: true, graceUntil: null })
      return
    }
    const humans = this.seats.filter((s) => !s.ghost)
    if (humans.every((s) => s.ws !== null)) {
      this.start(true)
    }
  }

  private hello(seat: Seat): void {
    this.send(seat, {
      type: 'hello',
      serverTime: Date.now(),
      matchId: this.id,
      mode: this.mode,
      you: seat,
      posters: this.posters,
      rematch: this.rematches,
    })
    this.send(seat, {
      type: 'sync',
      serverTime: Date.now(),
      beat: this.beat,
      deadline: this.deadline,
      pace: this.pace,
      draw: this.draw,
      ready: [this.seats[0].ready, this.seats[1].ready],
      holding: [this.seats[0].holding, this.seats[1].holding],
      connected: [
        this.seats[0].ws !== null || this.seats[0].ghost,
        this.seats[1].ws !== null || this.seats[1].ghost,
      ],
      last: this.last,
    })
  }

  leave(seat: Seat): void {
    this.seats[seat].ws = null
    this.send(other(seat), {
      type: 'presence',
      seat,
      connected: false,
      graceUntil: Date.now() + 5000,
    })
    if (this.beat === 'result' || this.beat === 'rematch' || this.beat === 'closed') {
      return
    }
    this.later(5000, () => {
      if (!this.seats[seat].ws && this.beat !== 'result') {
        this.finish('forfeit', other(seat), seat)
      }
    })
  }

  private start(intro: boolean): void {
    this.clear()
    for (const s of this.seats) {
      s.ready = s.ghost
      s.holding = false
      s.shot = null
      s.shotSeen = false
    }
    this.pace = 0
    this.paces = Math.round(between(5, 9))
    this.deadHeats = 0
    this.last = null
    this.votes = [false, false]
    if (intro) {
      this.setBeat('intro', 3000)
      this.later(3000, () => this.cock())
    } else {
      this.cock()
    }
  }

  private cock(): void {
    this.setBeat('cock', 10_000)
    this.later(10_000, () => {
      const lazy = ([0, 1] as const).find((s) => !this.seats[s].ready)
      if (lazy !== undefined) {
        this.finish('dodge', other(lazy), lazy)
      }
    })
  }

  onMessage(seat: Seat, raw: string): void {
    let m: RoomClientMessage
    try {
      m = JSON.parse(raw) as RoomClientMessage
    } catch {
      return
    }
    const s = this.seats[seat]
    switch (m.type) {
      case 'ready':
        this.onReady(seat)
        break
      case 'hold':
        s.holding = m.down
        this.syncGhostHold()
        this.broadcast({ type: 'holding', holding: [this.seats[0].holding, this.seats[1].holding] })
        break
      case 'shot':
        this.onShot(seat, m.localMs)
        break
      case 'rematch':
        this.onRematch(seat)
        break
      case 'flee':
        this.onFlee(seat)
        break
      default:
        break
    }
  }

  private onReady(seat: Seat): void {
    if (this.beat !== 'cock') {
      return
    }
    this.seats[seat].ready = true
    this.broadcast({ type: 'ready', seat })
    if (this.seats.every((x) => x.ready)) {
      this.clear()
      this.walk()
    }
  }

  /** A ghost mirrors the human's hold, a beat late. */
  private syncGhostHold(): void {
    const human = this.seats.find((x) => !x.ghost)
    for (const g of this.seats.filter((x) => x.ghost)) {
      g.holding = human?.holding ?? false
    }
  }

  private walk(): void {
    this.setBeat('walk', null)
    this.stallMs = 0
    this.walkTimer = setInterval(() => {
      const both = this.seats.every((x) => x.holding)
      this.stallMs = both ? 0 : this.stallMs + PACE_MS
      if (this.stallMs === 6000) {
        this.broadcast({ type: 'heckle' })
      }
      const auto = this.stallMs >= 10_000
      if (!(both || auto)) {
        return
      }
      this.pace++
      this.broadcast({ type: 'pace', n: this.pace, auto })
      if (this.pace >= this.paces) {
        this.clear()
        this.setBeat('turn', 600)
        this.later(600, () => this.wait(between(2000, 5000)))
      }
    }, PACE_MS)
  }

  private wait(ms: number): void {
    this.setBeat('wait', null)
    const r = Math.random()
    const fakes = r < 0.35 ? 0 : r < 0.8 ? 1 : 2
    for (let i = 0; i < fakes; i++) {
      const at = between(400, ms - 400)
      const cue = PVP_CUES[Math.floor(Math.random() * PVP_CUES.length)] ?? 'crow'
      this.later(at, () => this.broadcast({ type: 'cue', draw: this.draw, cue }))
    }
    this.later(ms, () => this.call())
  }

  private call(): void {
    this.callAt = performance.now()
    this.setBeat('called', 1500)
    this.broadcast({ type: 'call', draw: this.draw })
    for (const seat of [0, 1] as const) {
      const g = this.seats[seat]
      if (g.ghost) {
        this.later(g.draws, () => this.onShot(seat, g.draws))
      }
    }
    this.later(1500, () => this.judge())
  }

  private onShot(seat: Seat, localMs: number | null): void {
    const s = this.seats[seat]
    if (s.shotSeen) {
      return
    }
    s.shotSeen = true
    const early = localMs === null || this.beat !== 'called' || localMs < 100
    if (early && ['walk', 'turn', 'wait', 'called'].includes(this.beat)) {
      this.finish('coward', other(seat), seat)
      return
    }
    s.shot = Math.max(localMs ?? 0, performance.now() - this.callAt - 30)
    const human = this.seats.find((x) => !x.ghost)
    if (FORCE_DEAD_HEAT && !this.forcedOnce && !s.ghost && human) {
      this.forcedOnce = true
      const g = this.seats.find((x) => x.ghost)
      if (g) {
        g.shot = s.shot + 2
        g.shotSeen = true
      }
    }
    if (this.seats.every((x) => x.shot !== null)) {
      this.judge()
    }
  }

  private judge(): void {
    if (this.beat !== 'called') {
      return
    }
    this.clear()
    const [a, b] = [this.seats[0].shot, this.seats[1].shot]
    if (a === null && b === null) {
      this.finish('froze', null, null)
      return
    }
    if (a !== null && b !== null && Math.abs(a - b) <= 5) {
      this.deadHeats++
      this.broadcast({
        type: 'deadHeat',
        draw: this.draw,
        reactions: [a, b],
        deadHeats: this.deadHeats,
      })
      if (this.deadHeats >= 2) {
        this.later(1500, () => this.finish('draw', null, null))
        return
      }
      this.later(2200, () => this.suddenDeath())
      return
    }
    const winner: Seat = b === null || (a !== null && a < b) ? 0 : 1
    this.finish('win', winner, null)
  }

  private suddenDeath(): void {
    this.draw++
    for (const s of this.seats) {
      s.shot = null
      s.shotSeen = false
    }
    this.broadcast({ type: 'suddenDeath', draw: this.draw })
    this.wait(between(1500, 3500))
  }

  private finish(outcome: MatchOutcome, winner: Seat | null, culprit: Seat | null): void {
    if (this.beat === 'result' || this.beat === 'rematch' || this.beat === 'closed') {
      return
    }
    this.clear()
    this.setBeat('result', 4500)
    const reactions = [this.seats[0].shot, this.seats[1].shot] as const
    for (const seat of [0, 1] as const) {
      const won = winner === null ? null : winner === seat
      const you = this.seats[seat].ghost
        ? null
        : this.econ.settle(seat, won, outcome, reactions[seat])
      const r: DuelResult = {
        type: 'result',
        serverTime: Date.now(),
        matchId: this.id,
        draw: this.draw,
        outcome,
        winner,
        culprit,
        reactions,
        deadHeats: this.deadHeats,
        you,
        settled: true,
      }
      this.last = r
      this.send(seat, r)
    }
    this.rematchWindow()
  }

  private rematchWindow(): void {
    this.later(1500, () => {
      this.setBeat('rematch', REMATCH_WINDOW_MS)
      for (const seat of [0, 1] as const) {
        if (this.seats[seat].ghost) {
          this.votes[seat] = true
        }
      }
      this.sendVotes()
      this.later(REMATCH_WINDOW_MS, () => this.close('timeout'))
    })
  }

  private sendVotes(): void {
    this.broadcast({
      type: 'rematch',
      votes: this.votes,
      deadline: this.deadline ?? Date.now(),
      left: 5 - this.rematches,
    })
  }

  private onRematch(seat: Seat): void {
    if (this.beat !== 'rematch' && this.beat !== 'result') {
      return
    }
    this.votes[seat] = true
    this.sendVotes()
    if (this.votes.every(Boolean) && this.rematches < 5) {
      this.rematches++
      this.draw++
      this.start(false)
      this.hello(0)
      this.hello(1)
    }
  }

  private onFlee(seat: Seat): void {
    if (this.beat === 'intro' || this.beat === 'cock') {
      this.finish('dodge', other(seat), seat)
    } else if (this.beat === 'result' || this.beat === 'rematch') {
      this.close('opponent-left')
    } else {
      this.finish('forfeit', other(seat), seat)
    }
  }

  close(reason: 'done' | 'opponent-left' | 'timeout' | 'error'): void {
    this.clear()
    clearInterval(this.pingTimer)
    this.beat = 'closed'
    this.broadcast({ type: 'closed', reason })
    for (const s of this.seats) {
      s.ws?.close()
    }
  }
}
