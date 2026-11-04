/**
 * The standoff: one draw between two seats, from the start of the wait to a verdict. It owns the
 * wait (fake-out cues, then the call), records when the call went out on each human's socket,
 * collects shots, and judges them. Pure apart from the injected clock, so it is unit-testable.
 *
 * Two judging modes share it:
 * - `ranked`: the gauntlet. Seat 0 is a human, seat 1 an outlaw with one or more targets, judged
 *   with `judge.ts` exactly as the ranked DuelSession always has.
 * - `pvp`: Bounty Hunt. Two humans, or a human and a ghost/Town Outlaw, judged with `judge-pvp.ts`
 *   (dead heats, the resolution wait, TCP-capped RTT).
 *
 * The caller (DuelSession or DuelRoom) owns the transport and everything before and after.
 */
import { judgedReaction, MIN_REACTION_MS, tolerance } from '../judge.ts'
import type { DuelTuning } from '../tuning.ts'
import { judgePvp, type Pair, type PvpLink, type PvpVerdict, type Seat } from './judge-pvp.ts'
import { type AiOpponent, between, type Opponent, type Rng } from './opponents.ts'

export interface Clock {
  now: () => number
  /** Run `fn` after `ms`; returns a cancel function. */
  after: (ms: number, fn: () => void) => () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, Math.max(0, ms))
    return () => clearTimeout(timer)
  },
}

export interface PlannedCue {
  atMs: number
  cue: string
}

/** When each cue plays and when the call goes out, in ms from the start of the wait. */
export interface WaitPlan {
  cues: readonly PlannedCue[]
  callAtMs: number
}

export const MIN_CUE_GAP_MS = 350

/**
 * How far ahead of the call its message goes out (`call.inMs`). The client presents the call (the
 * bell, DRAW!, the turn) `inMs` after the message arrives, scheduled on its audio clock so the bell's
 * strike reaches the ear on the DRAW! frame even through a slow output device. The judging clock
 * starts at the call itself (send time + lead), so every seat's reaction is measured from the
 * moment its client presents it, exactly as before; a shot inside the lead is an early draw.
 */
export const CALL_LEAD_MS = 250

/** The gauntlet's wait, unchanged: optional boss clock, at most one fake-out, then the call. */
export function rankedWaitPlan(tuning: DuelTuning, rng: Rng = Math.random): WaitPlan {
  const cues: PlannedCue[] = []
  let callAtMs: number
  if (tuning.sequence) {
    let at = 0
    for (const cue of tuning.sequence.cues) {
      at += between(rng, ...tuning.sequence.intervalMs)
      cues.push({ atMs: at, cue })
    }
    callAtMs = at + between(rng, ...tuning.sequence.intervalMs)
  } else {
    callAtMs = between(rng, ...tuning.waitMs)
  }
  const cue = tuning.cues[Math.floor(rng() * tuning.cues.length)]
  if (cue && rng() < tuning.fakeChance && callAtMs > MIN_CUE_GAP_MS * 2) {
    cues.push({ atMs: between(rng, MIN_CUE_GAP_MS, callAtMs - MIN_CUE_GAP_MS), cue })
  }
  return { cues, callAtMs }
}

/** P(0) = 0.35, P(1) = 0.45, P(2) = 0.20. */
export function fakeCount(rng: Rng): number {
  const r = rng()
  if (r < 0.35) {
    return 0
  }
  return r < 0.8 ? 1 : 2
}

/**
 * Bounty Hunt's wait: W ∈ [minMs, maxMs], `count` fake-outs, each at least 350 ms from any other
 * cue, from the start, and from the call.
 */
export function pvpWaitPlan(
  cuePool: readonly string[],
  rng: Rng = Math.random,
  range: readonly [number, number] = [2000, 5000],
  count: number = fakeCount(rng),
): WaitPlan {
  const callAtMs = between(rng, ...range)
  // Spread `count` cues over the usable span with 350 ms gaps, by sampling sorted slack.
  const slots = Math.max(0, Math.min(count, Math.floor(callAtMs / MIN_CUE_GAP_MS) - 1))
  const slack = callAtMs - MIN_CUE_GAP_MS * (slots + 1)
  const offsets = Array.from({ length: slots }, () => rng() * slack).sort((a, b) => a - b)
  const cues = offsets.map((offset, i) => ({
    atMs: offset + MIN_CUE_GAP_MS * (i + 1),
    cue: cuePool[Math.floor(rng() * cuePool.length)] ?? 'crow',
  }))
  return { cues, callAtMs }
}

export type JudgeMode = 'ranked' | 'pvp'

export interface RankedVerdict {
  kind: 'ranked'
  outcome: 'win' | 'loss' | 'coward'
  reactionMs: number | null
  /** The earliest landing among the outlaws still standing at the end (or all, if none fired). */
  enemyMs: number | null
  targetsHit: number
}

export type FinalPvpVerdict = Exclude<PvpVerdict, { kind: 'pending' }>

export type Verdict = RankedVerdict | FinalPvpVerdict

/** What happened during the wait, for ghost recording. */
export interface WaitStats {
  fakesSeen: number
  /** Seat that drew early, and whether it was within 800 ms of a fake-out. */
  coward: { seat: Seat; onCue: boolean } | null
  /** Seconds each seat spent waiting before the call or its early draw. */
  waitedMs: number
}

export interface StandoffEvents {
  /** A fake-out cue: send it to every human. */
  cue: (cue: string) => void
  /**
   * Send the call to this human seat, to be presented `inMs` from now (0: at once). The call's time
   * on this seat is recorded as the send time (right after this returns) plus `inMs`.
   */
  call: (seat: Seat, inMs: number) => void
  /** The draw is decided. Called exactly once (unless aborted first). */
  end: (verdict: Verdict, stats: WaitStats) => void
}

export interface StandoffOptions {
  mode: JudgeMode
  seats: Pair<Opponent>
  plan: WaitPlan
  events: StandoffEvents
  clock?: Clock
  rng?: Rng
  /** Send the call this far ahead of it ({@link CALL_LEAD_MS}); 0 sends it at the call. */
  leadMs?: number
}

/** Slack added to the ranked loss deadline on top of the RTT and tolerance. */
const RANKED_DEADLINE_SLACK_MS = 50
const ON_CUE_WINDOW_MS = 800

interface Target {
  landsAtMs: number
  alive: boolean
}

export class Standoff {
  private readonly mode: JudgeMode
  private readonly seats: Pair<Opponent>
  private readonly plan: WaitPlan
  private readonly events: StandoffEvents
  private readonly clock: Clock
  private readonly rng: Rng
  private readonly leadMs: number
  /** The call has gone out ahead (the lead); it takes effect at `callAtMs`. */
  private announced = false as boolean
  private state: 'idle' | 'waiting' | 'called' | 'done' = 'idle'
  private startedAt = 0
  private lastCueAt = Number.NEGATIVE_INFINITY
  private fakesSeen = 0
  private readonly cancels: (() => void)[] = []
  private recheck: (() => void) | null = null

  private readonly callSentAt: [number, number] = [0, 0]
  private readonly shotSeenAt: [number | null, number | null] = [null, null]
  private readonly localMs: [number | null, number | null] = [null, null]
  /** Ranked: the outlaw's targets. PvP: the AI seat's single landing, if any. */
  private targets: Target[] = []
  private firstReaction: number | null = null

  constructor(options: StandoffOptions) {
    this.mode = options.mode
    this.seats = options.seats
    this.plan = options.plan
    this.events = options.events
    this.clock = options.clock ?? realClock
    this.rng = options.rng ?? Math.random
    this.leadMs = Math.max(0, Math.min(options.leadMs ?? 0, options.plan.callAtMs))
    if (
      this.mode === 'ranked' &&
      (this.seats[0].kind !== 'human' || this.seats[1].kind === 'human')
    ) {
      throw new Error('A ranked standoff is a human in seat 0 against an AI in seat 1.')
    }
  }

  get phase(): 'idle' | 'waiting' | 'called' | 'done' {
    return this.state
  }

  /** When the call went out, per seat (0 before the call). */
  get callTimes(): Pair<number> {
    return this.callSentAt
  }

  start(): void {
    if (this.state !== 'idle') {
      return
    }
    this.state = 'waiting'
    this.startedAt = this.clock.now()
    for (const { atMs, cue } of this.plan.cues) {
      this.cancels.push(this.clock.after(atMs, () => this.playCue(cue)))
    }
    if (this.leadMs > 0) {
      this.cancels.push(this.clock.after(this.plan.callAtMs - this.leadMs, () => this.announce()))
    }
    this.cancels.push(this.clock.after(this.plan.callAtMs, () => this.call()))
    this.scheduleAiBreaks()
  }

  /** Stop without a verdict (a disconnect, a flee). */
  abort(): void {
    this.state = 'done'
    this.clearTimers()
  }

  /**
   * A human seat fired. `localMs` is the client's own measurement from receiving the call (null
   * if it pressed before the call reached it). `target` picks an outlaw in ranked mode.
   */
  shot(seat: Seat, localMs: number | null, target = 0): void {
    if (this.state === 'done' || this.seats[seat].kind !== 'human') {
      return
    }
    if (this.state === 'waiting' || this.state === 'idle') {
      this.earlyDraw(seat)
      return
    }
    if (this.mode === 'ranked') {
      this.rankedShot(localMs, target)
      return
    }
    if (this.shotSeenAt[seat] !== null) {
      return
    }
    this.shotSeenAt[seat] = this.clock.now()
    this.localMs[seat] = localMs
    this.judge()
  }

  // --- the wait --------------------------------------------------------------------------------

  private aiSeat(): Seat | null {
    if (this.seats[1].kind !== 'human') {
      return 1
    }
    return this.seats[0].kind === 'human' ? null : 0
  }

  private ai(seat: Seat): AiOpponent | null {
    const opponent = this.seats[seat]
    return opponent.kind === 'human' ? null : opponent
  }

  private scheduleAiBreaks(): void {
    const seat = this.aiSeat()
    const ai = seat === null ? null : this.ai(seat)
    if (seat === null || !ai || ai.hazardPerSecond <= 0 || this.mode === 'ranked') {
      return
    }
    const breakAtMs = (-Math.log(Math.max(Number.EPSILON, this.rng())) / ai.hazardPerSecond) * 1000
    // never inside the lead: the call is already on its way to the human
    if (breakAtMs < this.plan.callAtMs - this.leadMs) {
      this.cancels.push(this.clock.after(breakAtMs, () => this.earlyDraw(seat)))
    }
  }

  private playCue(cue: string): void {
    if (this.state !== 'waiting') {
      return
    }
    this.fakesSeen++
    this.lastCueAt = this.clock.now()
    this.events.cue(cue)
    const seat = this.aiSeat()
    const ai = seat === null ? null : this.ai(seat)
    if (seat !== null && ai && this.mode === 'pvp' && ai.flinches(cue)) {
      // A flinch lands a beat after the cue, like a human's would (never inside the call's lead).
      const flinchMs = between(this.rng, 150, 300)
      const sinceStart = this.clock.now() - this.startedAt
      if (sinceStart + flinchMs < this.plan.callAtMs - this.leadMs) {
        this.cancels.push(this.clock.after(flinchMs, () => this.earlyDraw(seat)))
      }
    }
  }

  private earlyDraw(seat: Seat): void {
    if (this.state !== 'waiting' && this.state !== 'idle') {
      return
    }
    const onCue = this.clock.now() - this.lastCueAt <= ON_CUE_WINDOW_MS
    const stats = this.stats({ seat, onCue })
    if (this.mode === 'ranked') {
      this.finish(
        { kind: 'ranked', outcome: 'coward', reactionMs: -1, enemyMs: null, targetsHit: 0 },
        stats,
      )
      return
    }
    this.finish({ kind: 'coward', who: seat, ms: [null, null] }, stats)
  }

  /** The lead: every human gets the call now, to present `leadMs` from now. */
  private announce(): void {
    if (this.state !== 'waiting') {
      return
    }
    this.announced = true
    this.sendCall(this.leadMs)
  }

  private sendCall(inMs: number): void {
    for (const seat of [0, 1] as const) {
      if (this.seats[seat].kind === 'human') {
        this.events.call(seat, inMs)
        this.callSentAt[seat] = this.clock.now() + inMs
      }
    }
  }

  private call(): void {
    if (this.state !== 'waiting') {
      return
    }
    const ai = this.aiSeat()
    const aiOpponent = ai === null ? null : this.ai(ai)
    this.targets = (aiOpponent?.draw() ?? []).map((landsAtMs) => ({ landsAtMs, alive: true }))
    this.state = 'called'
    if (!this.announced) {
      this.sendCall(0)
    }
    // An AI seat "hears" the call when the first human does.
    if (ai !== null) {
      this.callSentAt[ai] = this.callSentAt[ai === 0 ? 1 : 0]
    }
    if (this.mode === 'ranked') {
      this.armRankedDeadline()
    } else {
      this.judge()
    }
  }

  // --- ranked judging (judge.ts) ---------------------------------------------------------------

  private humanLink(): PvpLink {
    const seat = this.seats[0]
    return seat.kind === 'human' ? seat.link() : { median: 0, jitter: 0, tcp: null }
  }

  /** The loss timer follows the earliest landing among the outlaws still standing. */
  private armRankedDeadline(): void {
    this.recheck?.()
    const alive = this.targets.filter((t) => t.alive)
    if (alive.length === 0) {
      return
    }
    const rtt = this.humanLink()
    const firstLanding = Math.min(...alive.map((t) => t.landsAtMs))
    const deadlineFromCall = firstLanding + rtt.median + tolerance(rtt) + RANKED_DEADLINE_SLACK_MS
    const delay = this.callSentAt[0] + deadlineFromCall - this.clock.now()
    this.recheck = this.clock.after(delay, () => this.rankedEnd('loss', this.firstReaction))
  }

  private rankedShot(localMs: number | null, target: number): void {
    const rtt = this.humanLink()
    const observed = this.clock.now() - this.callSentAt[0]
    const reaction = judgedReaction(observed, typeof localMs === 'number' ? localMs : null, rtt)
    if (reaction < MIN_REACTION_MS) {
      // Anticipation, not reaction: treated exactly like drawing before the call.
      const enemyMs = Math.round(Math.min(...this.targets.map((t) => t.landsAtMs)))
      this.finish(
        { kind: 'ranked', outcome: 'coward', reactionMs: -1, enemyMs, targetsHit: 0 },
        this.stats({ seat: 0, onCue: false }),
      )
      return
    }
    if (this.targets.some((t) => t.alive && t.landsAtMs <= reaction)) {
      this.rankedEnd('loss', this.firstReaction ?? reaction)
      return
    }
    this.firstReaction ??= reaction
    // A shot at a dead (or unknown) target goes to the next outlaw still standing.
    const chosen = Number.isInteger(target) ? this.targets[target] : undefined
    const enemy = chosen?.alive ? chosen : this.targets.find((t) => t.alive)
    if (enemy) {
      enemy.alive = false
    }
    if (this.targets.every((t) => !t.alive)) {
      this.rankedEnd('win', this.firstReaction)
      return
    }
    this.armRankedDeadline()
  }

  private rankedEnd(outcome: 'win' | 'loss', reaction: number | null): void {
    const alive = this.targets.filter((t) => t.alive)
    const pool = alive.length > 0 ? alive : this.targets
    const enemyMs = pool.length > 0 ? Math.round(Math.min(...pool.map((t) => t.landsAtMs))) : null
    this.finish(
      {
        kind: 'ranked',
        outcome,
        reactionMs: reaction === null ? null : Math.round(reaction),
        enemyMs,
        targetsHit: this.targets.filter((t) => !t.alive).length,
      },
      this.stats(null),
    )
  }

  // --- pvp judging (judge-pvp.ts) --------------------------------------------------------------

  private judge(): void {
    if (this.state !== 'called') {
      return
    }
    const ai = this.aiSeat()
    const fixedDraw = { ms: this.targets[0]?.landsAtMs ?? null }
    const link = (seat: Seat) => {
      const s = this.seats[seat]
      return s.kind === 'human' ? s.link() : { median: 0, jitter: 0, tcp: 0 }
    }
    const verdict = judgePvp({
      callSentAt: this.callSentAt,
      shotSeenAt: this.shotSeenAt,
      localMs: this.localMs,
      rtt: [link(0), link(1)],
      now: this.clock.now(),
      ...(ai === null ? {} : { fixed: ai === 1 ? [undefined, fixedDraw] : [fixedDraw, undefined] }),
    })
    if (verdict.kind === 'pending') {
      this.recheck?.()
      this.recheck = this.clock.after(verdict.recheckAt - this.clock.now(), () => this.judge())
      return
    }
    this.finish(verdict, this.stats(null))
  }

  // --- shared ----------------------------------------------------------------------------------

  private stats(coward: WaitStats['coward']): WaitStats {
    const end = this.state === 'waiting' ? this.clock.now() : this.startedAt + this.plan.callAtMs
    return { fakesSeen: this.fakesSeen, coward, waitedMs: Math.max(0, end - this.startedAt) }
  }

  private clearTimers(): void {
    for (const cancel of this.cancels) {
      cancel()
    }
    this.cancels.length = 0
    this.recheck?.()
    this.recheck = null
  }

  private finish(verdict: Verdict, stats: WaitStats): void {
    if (this.state === 'done') {
      return
    }
    this.state = 'done'
    this.clearTimers()
    this.events.end(verdict, stats)
  }
}
