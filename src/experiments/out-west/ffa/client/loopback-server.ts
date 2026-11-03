// biome-ignore-all lint/style/useThisInClassMethods: private helpers kept on the class next to the state they describe
/**
 * A loopback Frontier lobby: F's pure sim (`ffa/sim/`) plus F's server bots, speaking the exact
 * wire protocol of the Lobby DO (binary inputs and snapshots, JSON control). It runs in a worker
 * (`loopback.worker.ts`) so the client can be developed and profiled before, and independently of,
 * the real lobby. It is a dev and offline tool only: nothing it says touches a wallet.
 */
import { BotDirector, botName } from '../../../../../api/src/town/bots.ts'
import {
  BTN_CALLOUT,
  BTN_INTERACT,
  type ClientControl,
  CONTRACT_VERSION,
  MSG_INPUT,
  type RosterEntry,
  type ServerControl,
} from '../../contract/town.ts'
import { CATALOG } from '../../data/catalog.ts'
import { Writer } from '../sim/bytes.ts'
import { decodeInput, unwrapTick16 } from '../sim/codec.ts'
import { CALLOUT_RANGE, MAX_PLAYERS, TICK_HZ, TICK_MS } from '../sim/constants.ts'
import { InputQueue } from '../sim/input.ts'
import { radiansToAim } from '../sim/move.ts'
import { resolveShowdown } from '../sim/showdown.ts'
import { ClientStream, snapshotFor } from '../sim/snapshot.ts'
import { activePlayers, createWorld, dist2, type World } from '../sim/state.ts'
import type { InputFrame, Player, SimEvent } from '../sim/types.ts'
import { addPlayer, disconnectPlayer, removePlayer, step } from '../sim/world.ts'

export interface LoopbackOptions {
  bots: number
  seed?: number
  name?: string
  banked?: number
}

type Send = (data: Uint8Array | string) => void

const HATS = CATALOG.filter((i) => i.slot === 'hat').map((i) => i.id)
const OUTFITS = CATALOG.filter((i) => i.slot === 'outfit').map((i) => i.id)
/** A showdown with nobody drawing is judged this long after the bell. */
const JUDGE_MS = 1500

interface PendingDraw {
  id: number
  a: number
  b: number
  callAt: number
  shots: Map<number, number>
}

export class LoopbackServer {
  private readonly w: World
  private readonly bots: BotDirector
  private readonly send: Send
  private readonly writer = new Writer(4096)
  private readonly stream = new ClientStream()
  private readonly queue = new InputQueue()
  private readonly roster = new Map<number, RosterEntry>()
  private readonly opts: LoopbackOptions
  private human = -1
  private banked: number
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private ticks = 0
  private botSerial = 0
  private readonly draws = new Map<number, PendingDraw>()
  /** Bots that will accept a call-out at the given tick. */
  private readonly accepts = new Map<number, number>()
  private nextBotCallout = 0

  constructor(opts: LoopbackOptions, send: Send) {
    this.opts = opts
    this.send = send
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
    this.w = createWorld({ seed })
    this.bots = new BotDirector(seed)
    this.banked = opts.banked ?? 0
  }

  start(): void {
    const bots = Math.max(0, Math.min(MAX_PLAYERS - 1, this.opts.bots))
    for (let i = 0; i < bots; i++) {
      this.addBot()
    }
    this.human = addPlayer(this.w, {
      accountId: 'loopback-you',
      name: this.opts.name ?? 'You',
      level: 7,
      prestige: 0,
      bot: false,
    })
    this.roster.set(this.human, this.entry(this.human, this.opts.name ?? 'You', 7, false))
    this.control({
      type: 'welcome',
      contractVersion: CONTRACT_VERSION,
      lobbyId: 'loopback',
      you: this.human,
      tick: this.w.tick,
      tickHz: TICK_HZ,
      roster: [...this.roster.values()],
      banked: this.banked,
    })
    this.startedAt = performance.now()
    this.timer = setInterval(() => this.pump(), 5)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  receive(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      this.onControl(data)
      return
    }
    const bytes = new Uint8Array(data)
    if (bytes[0] !== MSG_INPUT) {
      return
    }
    const msg = decodeInput(bytes)
    if (msg) {
      this.queue.push(msg.seq, msg.frames)
    }
  }

  private onControl(text: string): void {
    let msg: ClientControl
    try {
      msg = JSON.parse(text) as ClientControl
    } catch {
      return
    }
    if (msg.type === 'bye') {
      const p = this.w.players[this.human]
      if (p) {
        disconnectPlayer(this.w, p)
      }
      this.stop()
      return
    }
    const draw = this.draws.get(msg.showdownId)
    if (draw && msg.localMs !== null && !draw.shots.has(this.human)) {
      draw.shots.set(this.human, Math.max(0, msg.localMs))
    }
  }

  private entry(id: number, name: string, level: number, bot: boolean): RosterEntry {
    const pick = <T>(list: readonly T[], k: number): T | undefined => list[k % list.length]
    const loadout = bot
      ? [pick(HATS, id * 7 + 3), pick(OUTFITS, id * 5 + 1)].filter((x) => x !== undefined)
      : ['hat.battered-brim', 'outfit.trail-duds']
    return { id, name, level, prestige: 0, bot, loadout }
  }

  private addBot(): void {
    const n = this.botSerial++
    const name = botName(n)
    const level = 1 + ((n * 13) % 40)
    const id = addPlayer(this.w, {
      accountId: `bot-${n}`,
      name,
      level,
      prestige: 0,
      bot: true,
    })
    if (id < 0) {
      return
    }
    const e = this.entry(id, name, level, true)
    this.roster.set(id, e)
    if (this.human >= 0) {
      this.control({ type: 'roster_add', entry: e })
    }
  }

  private control(msg: ServerControl): void {
    this.send(JSON.stringify(msg))
  }

  /** Catch up on every 50 ms tick that has elapsed (setInterval drifts; the sim must not). */
  private pump(): void {
    const due = Math.floor((performance.now() - this.startedAt) / TICK_MS)
    let n = 0
    while (this.ticks < due && n < 4) {
      this.tick()
      this.ticks++
      n++
    }
    if (this.ticks < due) {
      // Way behind (tab was frozen): drop the backlog rather than spiral.
      this.ticks = due
    }
  }

  private humanFrame(): InputFrame | null {
    const next = this.queue.next()
    if (!next) {
      return null
    }
    const f = next.frame
    return {
      seq: next.seq,
      moveX: f.moveX,
      moveZ: f.moveZ,
      aim: f.aim,
      buttons: f.buttons,
      viewTime: unwrapTick16(f.viewTick, this.w.tick) + f.viewFrac / 255,
    }
  }

  private tick(): void {
    const w = this.w
    const frames: (InputFrame | null)[] = Array.from({ length: MAX_PLAYERS }, () => null)
    if (this.human >= 0) {
      frames[this.human] = this.humanFrame()
    }
    this.bots.frames(w, frames)
    this.botDuels(frames)
    step(w, frames)
    // Verdicts land after the step (their events join this tick's snapshot).
    this.judgeDraws()
    this.afterStep(w.events)
    const me = w.players[this.human]
    if (me) {
      this.send(
        snapshotFor(w, me, this.stream, { banked: this.banked, events: w.events }, this.writer),
      )
    }
  }

  /** Bots accept call-outs most of the time, and now and then call out the human. */
  private botDuels(frames: (InputFrame | null)[]): void {
    const w = this.w
    for (const [id, at] of this.accepts) {
      const f = frames[id]
      if (w.tick >= at && f) {
        f.buttons |= BTN_INTERACT
        this.accepts.delete(id)
      }
    }
    const me = w.players[this.human]
    if (!me?.alive || w.tick < this.nextBotCallout) {
      return
    }
    this.nextBotCallout = w.tick + TICK_HZ * 20
    for (const p of activePlayers(w)) {
      const f = frames[p.id]
      if (!(p.bot && f && p.alive) || p.carried < 50) {
        continue
      }
      if (dist2(p.x, p.z, me.x, me.z) < (CALLOUT_RANGE - 2) ** 2) {
        f.aim = radiansToAim(Math.atan2(me.z - p.z, me.x - p.x))
        f.buttons = BTN_CALLOUT
        f.moveX = 0
        f.moveZ = 0
        return
      }
    }
  }

  private afterStep(events: readonly SimEvent[]): void {
    const w = this.w
    for (const ev of events) {
      if (ev.type === 'callout') {
        const target = w.players[ev.target]
        if (target?.bot && Math.random() < 0.8) {
          this.accepts.set(ev.target, w.tick + 6 + Math.floor(Math.random() * 30))
        }
      } else if (ev.type === 'showdown_call') {
        this.onCall(ev.id)
      } else if (ev.type === 'left') {
        this.onLeft(ev.player)
      }
    }
    for (const d of w.deposits.splice(0)) {
      if (d.playerId === this.human) {
        this.banked += d.amount + d.commission
        this.control({
          type: 'deposit',
          seq: d.seq,
          amount: d.amount,
          commission: d.commission,
          banked: this.banked,
          ok: true,
        })
      }
    }
    for (const p of [...activePlayers(w)]) {
      if (p.gone) {
        this.onLeft(p.id)
      }
    }
  }

  private onLeft(id: number): void {
    const p = this.w.players[id]
    if (!p) {
      return
    }
    removePlayer(this.w, id)
    this.bots.forget(id)
    this.roster.delete(id)
    this.control({ type: 'roster_remove', id })
    if (p.bot) {
      this.addBot()
    } else {
      this.stop()
    }
  }

  private onCall(id: number): void {
    const sd = this.w.showdowns.get(id)
    if (!sd) {
      return
    }
    const draw: PendingDraw = { id, a: sd.a, b: sd.b, callAt: performance.now(), shots: new Map() }
    for (const pid of [sd.a, sd.b]) {
      const p: Player | null | undefined = this.w.players[pid]
      if (p?.bot) {
        draw.shots.set(pid, 240 + Math.random() * 260)
      }
    }
    this.draws.set(id, draw)
    if (sd.a === this.human || sd.b === this.human) {
      this.control({ type: 'showdown_call', showdownId: id })
    }
  }

  private judgeDraws(): void {
    const now = performance.now()
    for (const d of [...this.draws.values()]) {
      const elapsed = now - d.callAt
      const ta = d.shots.get(d.a)
      const tb = d.shots.get(d.b)
      // A bot's draw only counts once its reaction time has actually elapsed.
      const has = (t: number | undefined) => t !== undefined && t <= elapsed
      const bothIn = has(ta) && has(tb)
      if (!bothIn && elapsed < JUDGE_MS) {
        const first = [
          [d.a, ta],
          [d.b, tb],
        ] as const
        // Someone has drawn and the other can no longer beat them.
        const done = first.some(([, t]) => has(t) && elapsed > (t ?? 0) + 400)
        if (!done) {
          continue
        }
      }
      this.draws.delete(d.id)
      const a = has(ta) ? (ta ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
      const b = has(tb) ? (tb ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
      if (!(Number.isFinite(a) || Number.isFinite(b))) {
        resolveShowdown(this.w, d.id, { kind: 'froze' })
      } else if (Math.abs(a - b) < 4) {
        resolveShowdown(this.w, d.id, { kind: 'dead_heat' })
      } else {
        const winner = a < b ? d.a : d.b
        resolveShowdown(this.w, d.id, { kind: 'win', winner, winnerMs: Math.min(a, b) })
      }
    }
  }
}
