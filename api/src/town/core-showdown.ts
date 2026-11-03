/**
 * Showdown judging for the lobby: the sim rings the bell, this records when each socket was told
 * (wall clock), takes `showdown_shot` messages, and runs the pure PvP judge until it has a verdict.
 * Bots draw with a sampled reaction.
 */
import type { ServerControl } from '../../../src/experiments/out-west/contract/town.ts'
import { Rng } from '../../../src/experiments/out-west/ffa/sim/rng.ts'
import {
  resolveShowdown,
  type ShowdownVerdict,
} from '../../../src/experiments/out-west/ffa/sim/showdown.ts'
import { type FixedDraw, judgePvp, type PvpLink, type PvpVerdict } from '../duel/judge-pvp.ts'
import { rttStats } from '../judge.ts'
import type { LobbyCore } from './core.ts'

const BOT_DRAW_MIN_MS = 190
const BOT_DRAW_MAX_MS = 340

interface Pending {
  id: number
  seats: [number, number]
  callSentAt: [number, number]
  shotSeenAt: [number | null, number | null]
  localMs: [number | null, number | null]
  fixed: [FixedDraw | undefined, FixedDraw | undefined]
}

export class ShowdownJudge {
  private readonly pending = new Map<number, Pending>()
  private readonly rng: Rng

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0xd1_ce)
  }

  /** A participant's draw. Before the bell (no pending record yet) the sim catches it as cowardice. */
  shot(showdownId: number, playerId: number, localMs: number | null, now: number): void {
    const p = this.pending.get(showdownId)
    if (!p) {
      return
    }
    const seat = p.seats.indexOf(playerId)
    if ((seat === 0 || seat === 1) && p.shotSeenAt[seat] === null) {
      p.shotSeenAt[seat] = now
      p.localMs[seat] = localMs
    }
  }

  private link(core: LobbyCore, playerId: number): PvpLink {
    const s = core.sessionOf(playerId)
    return { ...rttStats(s?.rtt ?? []), tcp: s?.tcpRtt ?? null }
  }

  private open(core: LobbyCore, id: number, a: number, b: number, now: number): void {
    const w = core.world
    const fixedFor = (pid: number): FixedDraw | undefined =>
      w.players[pid]?.bot ? { ms: this.rng.int(BOT_DRAW_MIN_MS, BOT_DRAW_MAX_MS) } : undefined
    this.pending.set(id, {
      id,
      seats: [a, b],
      callSentAt: [now, now],
      shotSeenAt: [null, null],
      localMs: [null, null],
      fixed: [fixedFor(a), fixedFor(b)],
    })
    const call = JSON.stringify({ type: 'showdown_call', showdownId: id } satisfies ServerControl)
    core.sessionOf(a)?.peer?.send(call)
    core.sessionOf(b)?.peer?.send(call)
  }

  private toVerdict(p: Pending, v: PvpVerdict): ShowdownVerdict | null {
    switch (v.kind) {
      case 'pending':
        return null
      case 'win':
        return { kind: 'win', winner: p.seats[v.winner], winnerMs: v.ms[v.winner] ?? 0 }
      case 'coward':
        return { kind: 'coward', who: p.seats[v.who] }
      case 'dead_heat':
        return { kind: 'dead_heat' }
      default:
        return { kind: 'froze' }
    }
  }

  /** After each sim step: open records for new bells, close finished ones, judge the rest. */
  update(core: LobbyCore, now: number): void {
    const w = core.world
    for (const ev of w.events) {
      if (ev.type === 'showdown_call') {
        const sd = w.showdowns.get(ev.id)
        if (sd) {
          this.open(core, sd.id, sd.a, sd.b, now)
        }
      } else if (ev.type === 'showdown_end') {
        this.pending.delete(ev.id)
      }
    }
    for (const p of [...this.pending.values()]) {
      if (!w.showdowns.has(p.id)) {
        this.pending.delete(p.id)
        continue
      }
      const verdict = this.toVerdict(
        p,
        judgePvp({
          callSentAt: p.callSentAt,
          shotSeenAt: p.shotSeenAt,
          localMs: p.localMs,
          rtt: [this.link(core, p.seats[0]), this.link(core, p.seats[1])],
          now,
          fixed: p.fixed,
        }),
      )
      if (verdict) {
        this.pending.delete(p.id)
        resolveShowdown(w, p.id, verdict)
      }
    }
  }
}
