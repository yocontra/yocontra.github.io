/**
 * LobbyCore: one Frontier lobby without the Workers plumbing. Sessions, send-on-change input
 * queues, rate limits, server bots, the tick, showdown judging, snapshots, and the money that must
 * be settled. The Lobby DO wraps it with sockets, timers and D1; tests and the bench drive it
 * directly.
 */
import {
  CONTRACT_VERSION,
  MSG_FULL_RESET,
  type RosterEntry,
  type ServerControl,
} from '../../../src/experiments/out-west/contract/town.ts'
import { Writer } from '../../../src/experiments/out-west/ffa/sim/bytes.ts'
import { decodeInput, unwrapTick16 } from '../../../src/experiments/out-west/ffa/sim/codec.ts'
import {
  MAX_INPUT_MSGS_PER_SEC,
  MAX_PLAYERS,
  SOFT_CAP,
  TICK_HZ,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import { InputQueue } from '../../../src/experiments/out-west/ffa/sim/input-queue.ts'
import { ClientStream, snapshotFor } from '../../../src/experiments/out-west/ffa/sim/snapshot.ts'
import {
  activePlayers,
  createWorld,
  type World,
} from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type {
  Deposit,
  InputFrame,
  Player,
} from '../../../src/experiments/out-west/ffa/sim/types.ts'
import {
  addPlayer,
  disconnectPlayer,
  reconnectPlayer,
  removePlayer,
  step,
} from '../../../src/experiments/out-west/ffa/sim/world.ts'
import { BotDirector, freshBotName } from './bots.ts'
import { ShowdownJudge } from './core-showdown.ts'

/** Lobbies keep at least this many bodies in town (bots fill in) while any human is present. */
export const DEFAULT_TOWN_POPULATION = 6
const MAX_MALFORMED = 20
const MAX_FLOOD_STRIKES = 60
const RTT_SAMPLES = 12
/** Aimbot heuristics (§3.7): flag, never auto-ban. */
const AIMBOT_MIN_SHOTS = 50
const AIMBOT_HIT_RATE = 0.85
const AIMBOT_SNAPS = 5
export const FLAG_AIMBOT = 1
export const FLAG_FLOOD = 2

/** Anything that can carry bytes or text to one client. */
export interface Peer {
  send: (data: Uint8Array | string) => void
  close: (code: number, reason: string) => void
}

export interface JoinProfile {
  accountId: string
  name: string
  level: number
  prestige: number
  loadout: readonly string[]
  /** Wallet balance as of joining. */
  banked: number
  tcpRtt: number | null
  /** False for dev accounts without a profile: nothing is written to D1 for them. */
  ledger?: boolean
}

export interface Session {
  playerId: number
  accountId: string
  name: string
  sessionId: string
  joinedAt: number
  peer: Peer | null
  queue: InputQueue
  stream: ClientStream
  banked: number
  roster: RosterEntry
  rtt: number[]
  tcpRtt: number | null
  windowStart: number
  windowCount: number
  strikes: number
  malformed: number
  flags: number
  xpFlushed: number
  xpFlushIndex: number
  ledger: boolean
  msgsIn: number
}

/** A session that finished (left, lingered out, or kicked): settle its stats. */
export interface Departure {
  session: Session
  player: Player
}

export interface SettledDeposit extends Deposit {
  sessionId: string
}

export interface TickOutput {
  deposits: SettledDeposit[]
  departures: Departure[]
}

export interface CoreMetrics {
  ticks: number
  bytesOut: number
  msgsOut: number
  msgsIn: number
  droppedIn: number
}

export class LobbyCore {
  readonly lobbyId: string
  world: World
  readonly sessions = new Map<number, Session>()
  private readonly byAccount = new Map<string, Session>()
  private readonly bots: BotDirector
  private readonly judge: ShowdownJudge
  private readonly writer = new Writer(4096)
  /** When each tick's snapshots went out (ms), for RTT from input acks. */
  private readonly sentAt = new Float64Array(64)
  /** Extra bots asked for (dev / load tests), on top of the default town population. */
  botTarget = 0
  readonly metrics: CoreMetrics = { ticks: 0, bytesOut: 0, msgsOut: 0, msgsIn: 0, droppedIn: 0 }

  constructor(lobbyId: string, seed: number) {
    this.lobbyId = lobbyId
    this.world = createWorld({ seed })
    this.bots = new BotDirector(seed)
    this.judge = new ShowdownJudge(seed)
  }

  /** Connected or lingering humans: the lobby ticks while this is above zero. */
  humans(): number {
    return this.sessions.size
  }

  connectedHumans(): number {
    let n = 0
    for (const s of this.sessions.values()) {
      if (s.peer) {
        n++
      }
    }
    return n
  }

  accounts(): string[] {
    return [...this.byAccount.keys()]
  }

  private broadcast(msg: ServerControl, except = -1): void {
    const text = JSON.stringify(msg)
    for (const s of this.sessions.values()) {
      if (s.peer && s.playerId !== except) {
        s.peer.send(text)
      }
    }
  }

  private roster(): RosterEntry[] {
    const out: RosterEntry[] = []
    for (const p of activePlayers(this.world)) {
      out.push(this.sessions.get(p.id)?.roster ?? rosterOf(p, []))
    }
    return out
  }

  private welcome(s: Session): void {
    s.peer?.send(new Uint8Array([MSG_FULL_RESET]))
    s.peer?.send(
      JSON.stringify({
        type: 'welcome',
        contractVersion: CONTRACT_VERSION,
        lobbyId: this.lobbyId,
        you: s.playerId,
        tick: this.world.tick,
        tickHz: TICK_HZ,
        roster: this.roster(),
        banked: s.banked,
      } satisfies ServerControl),
    )
  }

  /** Make room for a human by sending a bot home. */
  private evictBot(): boolean {
    for (const p of activePlayers(this.world)) {
      if (p.bot && p.showdown < 0) {
        this.world.burned += p.carried
        p.carried = 0
        p.gone = true
        return true
      }
    }
    return false
  }

  private occupied(): number {
    return [...activePlayers(this.world)].length
  }

  /**
   * A human joins (or rejoins: a lingering avatar is reclaimed with its carry). Returns the
   * session, or null if the lobby is full of humans.
   */
  join(profile: JoinProfile, peer: Peer, now: number): Session | null {
    const existing = this.byAccount.get(profile.accountId)
    if (existing) {
      existing.peer?.close(4000, 'Joined from somewhere else.')
      existing.peer = peer
      existing.stream.reset()
      existing.queue = new InputQueue()
      existing.tcpRtt = profile.tcpRtt
      const p = this.world.players[existing.playerId]
      if (p) {
        reconnectPlayer(p)
      }
      this.welcome(existing)
      return existing
    }
    while (this.occupied() >= MAX_PLAYERS && this.evictBot()) {
      this.reapGone()
    }
    const id = addPlayer(this.world, {
      accountId: profile.accountId,
      name: profile.name,
      level: profile.level,
      prestige: profile.prestige,
      bot: false,
    })
    const p = this.world.players[id]
    if (id < 0 || !p) {
      return null
    }
    const s: Session = {
      playerId: id,
      accountId: profile.accountId,
      name: profile.name,
      sessionId: crypto.randomUUID(),
      joinedAt: now,
      peer,
      queue: new InputQueue(),
      stream: new ClientStream(),
      banked: profile.banked,
      roster: rosterOf(p, profile.loadout),
      rtt: [],
      tcpRtt: profile.tcpRtt,
      windowStart: now,
      windowCount: 0,
      strikes: 0,
      malformed: 0,
      flags: 0,
      xpFlushed: 0,
      xpFlushIndex: 0,
      ledger: profile.ledger !== false,
      msgsIn: 0,
    }
    this.sessions.set(id, s)
    this.byAccount.set(profile.accountId, s)
    this.welcome(s)
    this.broadcast({ type: 'roster_add', entry: s.roster }, id)
    return s
  }

  /** The socket dropped: the avatar lingers (the sim drops its carry after 10 s). */
  disconnect(playerId: number, peer: Peer): void {
    const s = this.sessions.get(playerId)
    if (!s || s.peer !== peer) {
      return
    }
    s.peer = null
    const p = this.world.players[playerId]
    if (p) {
      disconnectPlayer(this.world, p)
    }
  }

  private kick(s: Session, reason: string): void {
    s.peer?.send(
      JSON.stringify({ type: 'error', message: reason, fatal: true } satisfies ServerControl),
    )
    const peer = s.peer
    if (peer) {
      this.disconnect(s.playerId, peer)
      peer.close(1008, reason)
    }
  }

  /** Flood control: at most 40 input messages per second; persistent flooding is kicked. */
  private admit(s: Session, now: number): boolean {
    if (now - s.windowStart >= 1000) {
      s.windowStart = now
      s.windowCount = 0
    }
    s.windowCount++
    s.msgsIn++
    this.metrics.msgsIn++
    if (s.windowCount <= MAX_INPUT_MSGS_PER_SEC) {
      return true
    }
    this.metrics.droppedIn++
    s.strikes++
    if (s.strikes > MAX_FLOOD_STRIKES) {
      s.flags |= FLAG_FLOOD
      this.kick(s, 'Too many messages.')
    }
    return false
  }

  onBinary(playerId: number, data: ArrayBuffer | Uint8Array, now: number): void {
    const s = this.sessions.get(playerId)
    if (!(s && this.admit(s, now))) {
      return
    }
    const msg = decodeInput(data)
    if (!msg) {
      s.malformed++
      if (s.malformed > MAX_MALFORMED) {
        this.kick(s, 'Malformed input.')
      }
      return
    }
    s.queue.push(msg.seq, msg.frames)
    // RTT from the ack: when that snapshot left, minus how long the client held it.
    const acked = unwrapTick16(msg.ackTick, this.world.tick)
    const sent = this.sentAt[acked & 63] ?? 0
    const rtt = now - sent - msg.ackAgeMs
    if (
      sent > 0 &&
      acked <= this.world.tick &&
      this.world.tick - acked < 60 &&
      rtt >= 0 &&
      rtt < 2000
    ) {
      s.rtt.push(rtt)
      if (s.rtt.length > RTT_SAMPLES) {
        s.rtt.shift()
      }
    }
  }

  onText(playerId: number, text: string, now: number): void {
    const s = this.sessions.get(playerId)
    if (!(s && this.admit(s, now)) || text.length > 512) {
      return
    }
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      s.malformed++
      return
    }
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
      return
    }
    if (msg.type === 'showdown_shot' && 'showdownId' in msg && 'localMs' in msg) {
      const localMs =
        typeof msg.localMs === 'number' && Number.isFinite(msg.localMs) ? msg.localMs : null
      this.judge.shot(Number(msg.showdownId), playerId, localMs, now)
    } else if (msg.type === 'bye') {
      const peer = s.peer
      if (peer) {
        this.disconnect(playerId, peer)
        peer.close(1000, 'Bye.')
      }
    }
  }

  private balanceBots(): void {
    const humans = this.humans()
    if (humans === 0) {
      return
    }
    // Ambient bots stay under the soft cap (room for humans); an explicit dev/load-test target may
    // fill all 32 slots (a joining human still sends one home).
    const cap = (this.botTarget > 0 ? MAX_PLAYERS : SOFT_CAP) - humans
    const wanted = Math.min(cap, Math.max(this.botTarget, DEFAULT_TOWN_POPULATION - humans))
    let bots = 0
    const names = new Set<string>()
    for (const p of activePlayers(this.world)) {
      bots += p.bot ? 1 : 0
      names.add(p.name)
    }
    if (bots > wanted) {
      this.evictBot()
    } else if (bots < wanted && this.occupied() < MAX_PLAYERS) {
      const n = this.world.tick + bots
      const id = addPlayer(this.world, {
        accountId: `bot:${this.lobbyId}:${n}`,
        name: freshBotName(n, names),
        level: 1 + (n % 25),
        prestige: 0,
        bot: true,
      })
      const p = this.world.players[id]
      if (p) {
        this.broadcast({ type: 'roster_add', entry: rosterOf(p, []) })
      }
    }
  }

  private framesForTick(): (InputFrame | null)[] {
    const frames: (InputFrame | null)[] = []
    for (const s of this.sessions.values()) {
      const next = s.queue.next()
      if (next) {
        const f = next.frame
        frames[s.playerId] = {
          seq: next.seq,
          moveX: f.moveX,
          moveZ: f.moveZ,
          aim: f.aim,
          buttons: f.buttons,
          viewTime: unwrapTick16(f.viewTick, this.world.tick) + f.viewFrac / 255,
        }
      }
    }
    this.bots.frames(this.world, frames)
    return frames
  }

  private sendSnapshots(now: number): void {
    this.sentAt[(this.world.tick - 1) & 63] = now
    for (const s of this.sessions.values()) {
      const p = this.world.players[s.playerId]
      if (!(s.peer && p)) {
        continue
      }
      const bytes = snapshotFor(
        this.world,
        { viewer: p, stream: s.stream },
        { banked: s.banked, events: this.world.events },
        this.writer,
      )
      s.peer.send(bytes)
      this.metrics.bytesOut += bytes.length
      this.metrics.msgsOut++
    }
  }

  /** Free slots of players who have gone; returns departing humans. */
  private reapGone(): Departure[] {
    const out: Departure[] = []
    for (const p of this.world.players.filter((q): q is Player => q?.gone === true)) {
      const s = this.sessions.get(p.id)
      if (s) {
        this.sessions.delete(p.id)
        this.byAccount.delete(s.accountId)
        s.peer?.close(1000, 'Left town.')
        out.push({ session: s, player: p })
      }
      this.bots.forget(p.id)
      removePlayer(this.world, p.id)
      this.broadcast({ type: 'roster_remove', id: p.id })
    }
    return out
  }

  private flagCheats(): void {
    for (const s of this.sessions.values()) {
      const st = this.world.players[s.playerId]?.stats
      if (
        st &&
        st.shots >= AIMBOT_MIN_SHOTS &&
        (st.hits / st.shots > AIMBOT_HIT_RATE || st.snapHits >= AIMBOT_SNAPS)
      ) {
        s.flags |= FLAG_AIMBOT
      }
    }
  }

  /** One 20 Hz tick. */
  tick(now: number): TickOutput {
    this.balanceBots()
    const frames = this.framesForTick()
    step(this.world, frames)
    this.judge.update(this, now)
    this.sendSnapshots(now)
    this.metrics.ticks++
    if (this.world.tick % TICK_HZ === 0) {
      this.flagCheats()
    }
    const deposits: SettledDeposit[] = []
    for (const d of this.world.deposits) {
      const s = this.sessions.get(d.playerId)
      if (d.bot || !s) {
        // Bots' banked money leaves the economy.
        this.world.burned += d.amount
        continue
      }
      deposits.push({ ...d, sessionId: s.sessionId })
    }
    this.world.deposits = []
    return { deposits, departures: this.reapGone() }
  }

  sessionOf(playerId: number): Session | undefined {
    return this.sessions.get(playerId)
  }

  /** A deposit was committed (or will retry): update the wallet and tell the player. */
  confirmDeposit(d: SettledDeposit, ok: boolean): void {
    const s = this.byAccount.get(d.accountId)
    if (!s || s.sessionId !== d.sessionId) {
      return
    }
    if (ok) {
      s.banked += d.amount + d.commission
    }
    s.peer?.send(
      JSON.stringify({
        type: 'deposit',
        seq: d.seq,
        amount: d.amount,
        commission: d.commission,
        banked: s.banked,
        ok,
      } satisfies ServerControl),
    )
  }

  notice(text: string): void {
    this.broadcast({ type: 'notice', text })
  }
}

function rosterOf(p: Player, loadout: readonly string[]): RosterEntry {
  return { id: p.id, name: p.name, level: p.level, prestige: p.prestige, bot: p.bot, loadout }
}
