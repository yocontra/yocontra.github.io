/**
 * The Bounty Hunt beat sheet, transport-agnostic: intro, cock, walk, turn, wait, call, judge,
 * result, rematch. The DuelRoom Durable Object feeds it socket events and gives it a clock; tests
 * drive it with a fake clock. Every timed decision is the server's.
 */
import {
  type Beat,
  type DuelResult,
  INTRO_MS,
  MAX_REMATCHES,
  type MatchOutcome,
  PACE_MS,
  PVP_CUES,
  READY_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  REMATCH_WINDOW_MS,
  type RoomClientMessage,
  type RoomServerMessage,
  type Settlement,
  STALL_AUTO_WALK_MS,
  STALL_HECKLE_MS,
  TAUNTS,
  TURN_MS,
} from '../../../src/experiments/out-west/contract/duel.ts'
import type { Pair, Seat } from './judge-pvp.ts'
import type { AiOpponent, Rng } from './opponents.ts'
import type { FinishedDuel, RestState, RoomFlowOptions, RoomIo } from './room-types.ts'
import { type Clock, pvpWaitPlan, Standoff, type Verdict, type WaitStats } from './standoff.ts'

/** Pause between a dead heat and the sudden-death wait (both men fall, then get up). */
export const DEAD_HEAT_PAUSE_MS = 2500
export const SUDDEN_DEATH_WAIT: readonly [number, number] = [1500, 3500]
const TAUNT_GAP_MS = 2000

const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0)

export class RoomFlow {
  private readonly makeAi: (() => AiOpponent) | null
  private readonly matchId: string
  private readonly io: RoomIo
  private readonly clock: Clock
  private readonly rng: Rng

  beat: Beat = 'intro'
  deadline: number | null = null
  rematch = 0
  draw = 0
  pace = 0
  private paces = 0
  private readonly ready: [boolean, boolean] = [false, false]
  private readonly holding: [boolean, boolean] = [false, false]
  readonly connected: [boolean, boolean] = [false, false]
  private readonly graceUntil: [number | null, number | null] = [null, null]
  private votes: [boolean, boolean] = [false, false]
  private deadHeats = 0
  private startedAt = 0
  private lastProgress = 0
  private heckled = false
  private autoWalk = false
  private standoff: Standoff | null = null
  private last: DuelResult | null = null
  private readonly lastTaunt: [number, number] = [0, 0]
  private timers: (() => void)[] = []
  private readonly graceTimers: [(() => void) | null, (() => void) | null] = [null, null]

  constructor(options: RoomFlowOptions) {
    this.makeAi = options.ai
    this.matchId = options.matchId ?? ''
    this.io = options.io
    this.clock = options.clock
    this.rng = options.rng ?? Math.random
    if (this.makeAi) {
      // The AI seat is always present, always ready, always holding.
      this.connected[1] = true
    }
  }

  private isAi(seat: Seat): boolean {
    return seat === 1 && this.makeAi !== null
  }

  private humans(): Seat[] {
    return this.makeAi ? [0] : [0, 1]
  }

  private broadcast(message: RoomServerMessage): void {
    for (const seat of this.humans()) {
      if (this.connected[seat]) {
        this.io.send(seat, message)
      }
    }
  }

  private clearTimers(): void {
    for (const cancel of this.timers) {
      cancel()
    }
    this.timers = []
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(this.clock.after(ms, fn))
  }

  private setBeat(beat: Beat, deadline: number | null = null): void {
    this.beat = beat
    this.deadline = deadline
    this.broadcast({ type: 'beat', serverTime: this.clock.now(), beat, deadline })
  }

  /** True while the duel is live and before the call (drops get a grace, flee is a dodge/forfeit). */
  private preCall(): boolean {
    return ['intro', 'cock', 'walk', 'turn', 'wait'].includes(this.beat)
  }

  // --- start -----------------------------------------------------------------------------------

  /** Begin a duel: the first from the queue (with an intro) or a rematch (without). */
  start(rematch = 0): void {
    this.clearTimers()
    this.rematch = rematch
    this.deadHeats = 0
    this.pace = 0
    this.votes = [false, false]
    this.ready.fill(false)
    this.holding.fill(false)
    this.startedAt = this.clock.now()
    if (this.makeAi) {
      this.ready[1] = true
      this.holding[1] = true
    }
    this.io.started?.(rematch)
    if (rematch === 0) {
      this.setBeat('intro', this.clock.now() + INTRO_MS)
      this.after(INTRO_MS, () => this.cock())
    } else {
      this.cock()
    }
  }

  private cock(): void {
    this.setBeat('cock', this.clock.now() + READY_TIMEOUT_MS)
    this.after(READY_TIMEOUT_MS, () => {
      const lazy = ([0, 1] as const).filter((s) => !this.ready[s])
      const [first] = lazy
      if (lazy.length === 2 || first === undefined) {
        this.closeRoom('timeout')
        return
      }
      this.finish('dodge', { winner: other(first), culprit: first })
    })
    this.maybeWalk()
  }

  private maybeWalk(): void {
    if (this.beat === 'cock' && this.ready[0] && this.ready[1]) {
      this.clearTimers()
      this.walk()
    }
  }

  // --- walk ------------------------------------------------------------------------------------

  private walk(): void {
    this.paces = 5 + Math.floor(this.rng() * 5)
    this.pace = 0
    this.lastProgress = this.clock.now()
    this.heckled = false
    this.autoWalk = false
    this.setBeat('walk')
    this.after(PACE_MS, () => this.walkTick())
  }

  private walkTick(): void {
    if (this.beat !== 'walk') {
      return
    }
    const now = this.clock.now()
    const someoneAway = !(this.connected[0] && this.connected[1])
    if (someoneAway) {
      // A drop pauses the walk and its stall clock until they're back or forfeit.
      this.lastProgress = now
    } else if (this.autoWalk || (this.holding[0] && this.holding[1])) {
      this.pace++
      this.lastProgress = now
      this.broadcast({ type: 'pace', n: this.pace, auto: this.autoWalk })
      if (this.pace >= this.paces) {
        this.turn()
        return
      }
    } else if (now - this.lastProgress >= STALL_AUTO_WALK_MS) {
      this.autoWalk = true
    } else if (!this.heckled && now - this.lastProgress >= STALL_HECKLE_MS) {
      this.heckled = true
      this.broadcast({ type: 'heckle' })
    }
    this.after(PACE_MS, () => this.walkTick())
  }

  private turn(): void {
    this.clearTimers()
    this.setBeat('turn', this.clock.now() + TURN_MS)
    this.after(TURN_MS, () => this.wait(false))
  }

  // --- wait, call, judge -----------------------------------------------------------------------

  private wait(suddenDeath: boolean): void {
    this.clearTimers()
    this.draw++
    const draw = this.draw
    const plan = suddenDeath
      ? pvpWaitPlan(PVP_CUES, this.rng, SUDDEN_DEATH_WAIT, this.rng() < 0.5 ? 0 : 1)
      : pvpWaitPlan(PVP_CUES, this.rng)
    const human = (seat: Seat) => ({ kind: 'human' as const, link: () => this.io.link(seat) })
    const standoff: Standoff = new Standoff({
      mode: 'pvp',
      seats: [human(0), this.makeAi ? this.makeAi() : human(1)],
      plan,
      clock: this.clock,
      rng: this.rng,
      events: {
        cue: (cue) => this.broadcast({ type: 'cue', draw, cue }),
        call: (seat) => {
          if (this.connected[seat]) {
            this.io.send(seat, { type: 'call', draw })
          }
          this.beat = 'called'
        },
        end: (verdict, stats) => {
          if (this.standoff === standoff) {
            this.standoff = null
            this.onVerdict(verdict, stats)
          }
        },
      },
    })
    this.standoff = standoff
    if (suddenDeath) {
      this.broadcast({ type: 'suddenDeath', draw })
    }
    this.setBeat('wait')
    standoff.start()
  }

  private onVerdict(verdict: Verdict, stats: WaitStats): void {
    if (verdict.kind === 'ranked') {
      return
    }
    const ms = verdict.ms
    switch (verdict.kind) {
      case 'win':
        this.finish('win', { winner: verdict.winner, culprit: null }, ms, stats)
        return
      case 'coward':
        this.finish('coward', { winner: other(verdict.who), culprit: verdict.who }, ms, stats)
        return
      case 'froze':
        this.finish('froze', { winner: null, culprit: null }, ms, stats)
        return
      default:
        break
    }
    this.deadHeats++
    if (this.deadHeats >= 2) {
      this.finish('draw', { winner: null, culprit: null }, ms, stats)
      return
    }
    this.broadcast({ type: 'deadHeat', draw: this.draw, reactions: ms, deadHeats: this.deadHeats })
    this.beat = 'turn'
    this.after(DEAD_HEAT_PAUSE_MS, () => this.wait(true))
  }

  // --- result and rematch ----------------------------------------------------------------------

  private finish(
    outcome: MatchOutcome,
    who: { winner: Seat | null; culprit: Seat | null },
    reactions: Pair<number | null> = [null, null],
    wait: WaitStats | null = null,
  ): void {
    const { winner, culprit } = who
    this.clearTimers()
    this.standoff?.abort()
    this.standoff = null
    for (const seat of [0, 1] as const) {
      this.graceTimers[seat]?.()
      this.graceTimers[seat] = null
      this.graceUntil[seat] = null
    }
    const now = this.clock.now()
    const deadline = now + REMATCH_WINDOW_MS
    this.setBeat('result', deadline)
    const duel: FinishedDuel = {
      rematch: this.rematch,
      outcome,
      winner,
      culprit,
      reactions: [reactions[0], reactions[1]],
      deadHeats: this.deadHeats,
      wait,
      startedAt: this.startedAt,
      endedAt: now,
    }
    const base: DuelResult = {
      type: 'result',
      serverTime: now,
      matchId: this.matchId,
      draw: this.draw,
      outcome,
      winner,
      culprit,
      reactions: duel.reactions,
      deadHeats: this.deadHeats,
      you: null,
      settled: false,
    }
    this.last = base
    const sendResults = (settlements: Pair<Settlement | null> | null) => {
      for (const seat of this.humans()) {
        const you = settlements?.[seat] ?? null
        const message = {
          ...base,
          serverTime: this.clock.now(),
          you,
          settled: settlements !== null,
        }
        this.last = { ...message, you: null }
        if (this.connected[seat]) {
          this.io.send(seat, message)
        }
      }
      this.afterResult(outcome, culprit)
    }
    this.io.settle(duel).then(sendResults, () => sendResults(null))
  }

  private afterResult(outcome: MatchOutcome, culprit: Seat | null): void {
    if (outcome === 'dodge' && culprit !== null) {
      // A dodge ends the room; the dodged player goes back to the front of the queue.
      this.io.requeue?.(other(culprit))
      this.closeRoom('opponent-left')
      return
    }
    const anyone = this.humans().some((s) => this.connected[s])
    if (!anyone || this.rematch >= MAX_REMATCHES) {
      this.closeRoom('done')
      return
    }
    this.broadcastVotes()
    this.io.idle(this.deadline ?? this.clock.now())
  }

  private broadcastVotes(): void {
    this.broadcast({
      type: 'rematch',
      votes: this.votes,
      deadline: this.deadline ?? this.clock.now(),
      left: MAX_REMATCHES - this.rematch,
    })
  }

  private vote(seat: Seat): void {
    if (this.beat !== 'result' || this.rematch >= MAX_REMATCHES) {
      return
    }
    this.votes[seat] = true
    if (this.makeAi) {
      this.votes[1] = true
    }
    this.broadcastVotes()
    if (this.votes[0] && this.votes[1]) {
      this.start(this.rematch + 1)
    }
  }

  /** The rematch window ran out (the host's alarm). */
  rematchExpired(): void {
    if (this.beat === 'result') {
      this.closeRoom('done')
    }
  }

  private closeRoom(reason: 'done' | 'opponent-left' | 'timeout'): void {
    this.clearTimers()
    this.standoff?.abort()
    this.beat = 'closed'
    this.broadcast({ type: 'closed', reason })
    this.io.close(reason)
  }

  // --- connections -----------------------------------------------------------------------------

  connect(seat: Seat): void {
    this.connected[seat] = true
    this.graceTimers[seat]?.()
    this.graceTimers[seat] = null
    const wasAway = this.graceUntil[seat] !== null
    this.graceUntil[seat] = null
    this.io.send(seat, this.sync())
    this.sendPresence(seat, true, null)
    if (wasAway && this.beat === 'wait' && !this.standoff) {
      // The wait re-rolls after a reconnect.
      this.turn()
    }
  }

  disconnect(seat: Seat): void {
    if (!this.connected[seat]) {
      return
    }
    this.connected[seat] = false
    this.holding[seat] = false
    if (this.beat === 'result' || this.beat === 'closed') {
      if (!this.humans().some((s) => this.connected[s]) && this.beat === 'result') {
        this.closeRoom('done')
      }
      return
    }
    if (!this.preCall()) {
      // After the call there is no grace; any shot already received counts.
      return
    }
    const until = this.clock.now() + RECONNECT_GRACE_MS
    this.graceUntil[seat] = until
    if (this.beat === 'wait' && this.standoff?.phase === 'waiting') {
      this.standoff.abort()
      this.standoff = null
      this.clearTimers()
    }
    this.sendPresence(seat, false, until)
    this.graceTimers[seat] = this.clock.after(RECONNECT_GRACE_MS, () => this.graceExpired(seat))
  }

  private graceExpired(seat: Seat): void {
    this.graceTimers[seat] = null
    if (this.connected[seat] || !this.preCall()) {
      return
    }
    const dodge = this.beat === 'intro' || this.beat === 'cock'
    this.finish(dodge ? 'dodge' : 'forfeit', { winner: other(seat), culprit: seat })
  }

  private sendPresence(seat: Seat, connected: boolean, graceUntil: number | null): void {
    const peer = other(seat)
    if (!this.isAi(peer) && this.connected[peer]) {
      this.io.send(peer, { type: 'presence', seat, connected, graceUntil })
    }
  }

  sync(): RoomServerMessage {
    return {
      type: 'sync',
      serverTime: this.clock.now(),
      beat: this.beat,
      deadline: this.deadline,
      pace: this.pace,
      draw: this.draw,
      ready: [this.ready[0], this.ready[1]],
      holding: [this.holding[0], this.holding[1]],
      connected: [this.connected[0], this.connected[1]],
      last: this.last,
    }
  }

  // --- messages --------------------------------------------------------------------------------

  message(seat: Seat, message: RoomClientMessage): void {
    switch (message.type) {
      case 'ready':
        if (this.beat === 'cock' && !this.ready[seat]) {
          this.ready[seat] = true
          this.broadcast({ type: 'ready', seat })
          this.maybeWalk()
        }
        return
      case 'hold':
        if (this.holding[seat] !== Boolean(message.down)) {
          this.holding[seat] = Boolean(message.down)
          this.broadcast({ type: 'holding', holding: [this.holding[0], this.holding[1]] })
        }
        return
      case 'shot':
        if (message.draw === this.draw && this.standoff) {
          const local = typeof message.localMs === 'number' ? message.localMs : null
          this.standoff.shot(seat, local)
        }
        return
      case 'taunt':
        this.taunt(seat, message.taunt)
        return
      case 'rematch':
        this.vote(seat)
        return
      case 'flee':
        this.flee(seat)
        return
      default:
        return
    }
  }

  private taunt(seat: Seat, taunt: unknown): void {
    const now = this.clock.now()
    const allowed = this.beat === 'intro' || this.beat === 'result'
    if (!allowed || now - this.lastTaunt[seat] < TAUNT_GAP_MS) {
      return
    }
    const known = TAUNTS.find((t) => t === taunt)
    if (known) {
      this.lastTaunt[seat] = now
      this.broadcast({ type: 'taunt', seat, taunt: known })
    }
  }

  private flee(seat: Seat): void {
    if (this.beat === 'intro' || this.beat === 'cock') {
      this.finish('dodge', { winner: other(seat), culprit: seat })
    } else if (this.preCall()) {
      this.finish('forfeit', { winner: other(seat), culprit: seat })
    }
  }

  // --- hibernation -----------------------------------------------------------------------------

  rest(): RestState | null {
    if (this.beat !== 'result' || this.deadline === null) {
      return null
    }
    return { rematch: this.rematch, votes: this.votes, deadline: this.deadline, last: this.last }
  }

  /** Rebuild after the host woke from hibernation during the rematch window. */
  restore(state: RestState, connected: Pair<boolean>): void {
    this.beat = 'result'
    this.rematch = state.rematch
    this.votes = [state.votes[0], state.votes[1]]
    this.deadline = state.deadline
    this.last = state.last
    this.connected[0] = connected[0]
    if (!this.makeAi) {
      this.connected[1] = connected[1]
    }
    this.draw = state.last?.draw ?? 0
  }
}
