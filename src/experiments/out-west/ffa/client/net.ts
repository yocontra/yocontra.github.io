// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `haveSelf` flips on the first snapshot; Biome narrows it to its initialiser
/**
 * The Frontier client netcode: send-on-change input (`InputBatcher`), own-player prediction with
 * the server's exact `stepMove`, reconciliation on `lastInputSeq` (snap to the server's move
 * state, replay unacknowledged frames, smooth small errors over 100 ms), interpolation of everyone
 * else 100 ms in the past, and the event stream.
 */
import {
  BTN_FIRE,
  MSG_FULL_RESET,
  MSG_SNAPSHOT,
  NONE,
  POS_SCALE,
  type RosterEntry,
  SELF_ALIVE,
  SELF_FROZEN,
  SELF_IN_SHOWDOWN,
  type ServerControl,
  selfWeapon,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import { Writer } from '../sim/bytes.ts'
import {
  decodeSnapshot,
  type EntityView,
  encodeInput,
  type SelfView,
  type TownView,
  type WireFrame,
} from '../sim/codec.ts'
import type { WireEvent } from '../sim/codec-events.ts'
import {
  INTEREST_NEAR,
  REVOLVER_FIRE_MS,
  RIFLE_FIRE_MS,
  SHOTGUN_FIRE_MS,
  TICK_MS,
} from '../sim/constants.ts'
import { InputBatcher, quantizeAim } from '../sim/input.ts'
import { buildGrid, type Grid } from '../sim/layout.ts'
import { aimRadians, stepMove } from '../sim/move.ts'
import type { MoveState } from '../sim/types.ts'
import { INTERP_TICKS, RemoteTrack, type RemoteView, ServerClock } from './interp.ts'
import type { Transport } from './transport.ts'

/** Errors under this are smoothed out over `SMOOTH_MS`; larger ones snap (spec §3.5). */
const SMOOTH_UNDER_M = 0.1
const SMOOTH_MS = 100
const MAX_PENDING = 64

export interface Intent {
  /** −127..127, +x east, +z south. */
  moveX: number
  moveZ: number
  /** u16 turns. */
  aim: number
  buttons: number
}

export interface NetHandlers {
  onWelcome: (you: number) => void
  onControl: (msg: ServerControl) => void
  onEvent: (ev: WireEvent, tick: number) => void
  /** A shot this client predicted (muzzle flash, tracer and sound before the server answers). */
  onPredictedShot: (x: number, z: number, aim: number, weapon: number) => void
}

interface Pending {
  seq: number
  frame: WireFrame
  /** This frame's fire press was predicted as a shot. */
  shot: boolean
}

const FIRE_MS: Record<number, number> = {
  [WEAPON_REVOLVER]: REVOLVER_FIRE_MS,
  [WEAPON_SHOTGUN]: SHOTGUN_FIRE_MS,
  [WEAPON_RIFLE]: RIFLE_FIRE_MS,
}

const seqDiff = (a: number, b: number): number => ((a - b + 98_304) % 65_536) - 32_768

export class NetClient {
  readonly grid: Grid = buildGrid()
  readonly roster = new Map<number, RosterEntry>()
  readonly remotes = new Map<number, RemoteTrack>()
  readonly clock = new ServerClock()
  you = -1
  lobbyId = ''
  banked = 0
  self: SelfView | null = null
  town: TownView | null = null
  /** Newest snapshot tick, and when it arrived (performance.now). */
  lastTick = -1
  lastArrival = 0
  /** Smoothed reconciliation error (m) and corrections per second, for the perf overlay. */
  reconErr = 0
  snaps = 0
  bytesIn = 0
  bytesOut = 0
  /** Predicted own move state after the newest local tick, and the one before (render lerp). */
  readonly pred: MoveState = { x: 0, z: 0, rollTicks: 0, rollCooldown: 0, rollDirX: 1, rollDirZ: 0 }
  readonly prev: MoveState = { ...this.pred }
  private smoothX = 0
  private smoothZ = 0
  private readonly batcher = new InputBatcher()
  private readonly writer = new Writer(256)
  private readonly baseline = new Map<number, EntityView>()
  private readonly pending: Pending[] = []
  private prevButtons = 0
  private haveSelf = false
  private localCooldownUntil = 0
  private predictedShots = 0
  private readonly handlers: NetHandlers
  private transport: Transport | null = null

  constructor(handlers: NetHandlers) {
    this.handlers = handlers
  }

  attach(t: Transport): void {
    this.transport = t
  }

  /** A reconnect: the server sends `MSG_FULL_RESET` too, but never trust a stale baseline. */
  reset(): void {
    this.baseline.clear()
    this.remotes.clear()
    this.pending.length = 0
  }

  get alive(): boolean {
    return ((this.self?.flags ?? 0) & SELF_ALIVE) !== 0
  }

  get canMove(): boolean {
    const f = this.self?.flags ?? 0
    return (f & SELF_ALIVE) !== 0 && (f & SELF_FROZEN) === 0
  }

  /** The gun in hand (revolver, or a map pickup) and whether you hold dynamite. */
  get weapon(): { weapon: number; rounds: number; dynamite: boolean } {
    return selfWeapon(this.self?.weapon ?? 0)
  }

  /** Rounds left, counting shots predicted but not yet acknowledged. */
  get ammo(): number {
    const w = this.weapon
    const have = w.weapon === WEAPON_REVOLVER ? (this.self?.ammo ?? 0) : w.rounds
    return Math.max(0, have - this.predictedShots)
  }

  handle(data: ArrayBuffer | string, nowMs: number): void {
    if (typeof data === 'string') {
      this.bytesIn += data.length
      this.onText(data)
      return
    }
    this.bytesIn += data.byteLength
    const kind = new Uint8Array(data)[0]
    if (kind === MSG_FULL_RESET) {
      this.reset()
      return
    }
    if (kind !== MSG_SNAPSHOT) {
      return
    }
    const snap = decodeSnapshot(data, this.baseline)
    if (!snap) {
      return
    }
    this.snaps++
    this.lastTick = snap.tick
    this.lastArrival = nowMs
    this.clock.observe(snap.tick, nowMs)
    this.self = snap.self
    if (snap.town) {
      this.town = snap.town
    }
    for (const id of snap.removed) {
      this.remotes.delete(id)
    }
    const changed = new Set<number>()
    for (const e of snap.entities) {
      changed.add(e.id)
      this.track(e.id).push(snap.tick, e)
    }
    // Silence means unchanged, inside the full-rate radius. Farther entities refresh every other
    // tick, so a missing one there is not a sample.
    const near2 = (INTEREST_NEAR - 1.5) ** 2
    const sx = snap.self.x / POS_SCALE
    const sz = snap.self.z / POS_SCALE
    for (const [id, e] of this.baseline) {
      if (changed.has(id)) {
        continue
      }
      const dx = e.x / POS_SCALE - sx
      const dz = e.z / POS_SCALE - sz
      if (dx * dx + dz * dz < near2) {
        this.track(id).push(snap.tick, e)
      }
    }
    this.reconcile(snap.self, snap.lastInputSeq)
    for (const ev of snap.events) {
      this.handlers.onEvent(ev, snap.tick)
    }
  }

  private track(id: number): RemoteTrack {
    let t = this.remotes.get(id)
    if (!t) {
      t = new RemoteTrack(id)
      this.remotes.set(id, t)
    }
    return t
  }

  private onText(text: string): void {
    let msg: ServerControl
    try {
      msg = JSON.parse(text) as ServerControl
    } catch {
      return
    }
    switch (msg.type) {
      case 'welcome':
        this.you = msg.you
        this.lobbyId = msg.lobbyId
        this.banked = msg.banked
        this.roster.clear()
        for (const r of msg.roster) {
          this.roster.set(r.id, r)
        }
        this.handlers.onWelcome(msg.you)
        break
      case 'roster_add':
        this.roster.set(msg.entry.id, msg.entry)
        break
      case 'roster_remove':
        this.roster.delete(msg.id)
        this.remotes.delete(msg.id)
        break
      case 'deposit':
        this.banked = msg.banked
        break
      default:
        break
    }
    this.handlers.onControl(msg)
  }

  /** Snap to the server's move state, then replay every frame it hasn't consumed yet. */
  private reconcile(s: SelfView, lastSeq: number): void {
    while (this.pending.length > 0 && seqDiff(this.pending[0]?.seq ?? 0, lastSeq) <= 0) {
      const p = this.pending.shift()
      if (p?.shot) {
        // Its shot is now in the server's ammo count.
        this.predictedShots = Math.max(0, this.predictedShots - 1)
      }
    }
    if (this.pending.length === 0) {
      this.predictedShots = 0
    }
    const rollRad = aimRadians(s.rollDir)
    const m: MoveState = {
      x: s.x / POS_SCALE,
      z: s.z / POS_SCALE,
      rollTicks: s.rollTicks,
      rollCooldown: s.rollCooldown,
      rollDirX: Math.cos(rollRad),
      rollDirZ: Math.sin(rollRad),
    }
    const canMove =
      (s.flags & SELF_ALIVE) !== 0 && (s.flags & (SELF_FROZEN | SELF_IN_SHOWDOWN)) === 0
    let prevButtons = s.lastButtons
    for (const p of this.pending) {
      stepMove(this.grid, m, {
        moveX: p.frame.moveX,
        moveZ: p.frame.moveZ,
        aim: p.frame.aim,
        buttons: p.frame.buttons,
        prevButtons,
        canMove,
      })
      prevButtons = p.frame.buttons
    }
    if (!this.haveSelf) {
      this.haveSelf = true
      Object.assign(this.pred, m)
      Object.assign(this.prev, m)
      return
    }
    const ex = this.pred.x - m.x
    const ez = this.pred.z - m.z
    const err = Math.hypot(ex, ez)
    this.reconErr += (err - this.reconErr) * 0.1
    if (err > 1e-4 && err < SMOOTH_UNDER_M) {
      this.smoothX += ex
      this.smoothZ += ez
    } else if (err >= SMOOTH_UNDER_M) {
      this.smoothX = 0
      this.smoothZ = 0
      // Snap: no lerp across the correction.
      Object.assign(this.prev, m)
    }
    Object.assign(this.pred, m)
  }

  /**
   * One 20 Hz client tick: number the frame, send it if the batcher says so, and predict it.
   * `renderTick` is the remote-entity time on screen (for the server's hit rewind).
   */
  tick(intent: Intent, renderTick: number, nowMs: number): void {
    const viewTick = Math.max(0, Math.floor(renderTick))
    const frame: WireFrame = {
      moveX: intent.moveX,
      moveZ: intent.moveZ,
      aim: quantizeAim(intent.aim),
      buttons: intent.buttons,
      viewTick: viewTick & 0xff_ff,
      viewFrac: Math.round((renderTick - viewTick) * 255),
    }
    const seq = this.batcher.nextSeq
    const out = this.batcher.push(frame)
    if (out && this.transport) {
      const bytes = encodeInput(this.writer, {
        seq: out.seq,
        ackTick: this.lastTick & 0xff_ff,
        ackAgeMs: Math.round(nowMs - this.lastArrival),
        frames: out.frames,
      })
      this.bytesOut += bytes.byteLength
      this.transport.send(bytes)
    }
    if (!this.haveSelf) {
      this.prevButtons = frame.buttons
      return
    }
    const shot = this.predictShot(frame, nowMs)
    this.pending.push({ seq, frame, shot })
    if (this.pending.length > MAX_PENDING) {
      this.pending.shift()
    }
    Object.assign(this.prev, this.pred)
    stepMove(this.grid, this.pred, {
      moveX: frame.moveX,
      moveZ: frame.moveZ,
      aim: frame.aim,
      buttons: frame.buttons,
      prevButtons: this.prevButtons,
      canMove: this.canMove,
    })
    this.prevButtons = frame.buttons
  }

  /** Mirror the server's fire checks closely enough to flash the muzzle without waiting. */
  private predictShot(frame: WireFrame, nowMs: number): boolean {
    const pressed = (frame.buttons & BTN_FIRE) !== 0 && (this.prevButtons & BTN_FIRE) === 0
    const s = this.self
    if (!(pressed && s && this.canMove)) {
      return false
    }
    const blocked =
      this.pred.rollTicks > 0 ||
      (s.reloadTicks > 0 && this.weapon.weapon === WEAPON_REVOLVER) ||
      this.ammo <= 0 ||
      nowMs < this.localCooldownUntil
    if (blocked) {
      return false
    }
    const weapon = this.weapon.weapon
    this.localCooldownUntil = nowMs + (FIRE_MS[weapon] ?? REVOLVER_FIRE_MS) - TICK_MS / 2
    this.predictedShots++
    this.handlers.onPredictedShot(this.pred.x, this.pred.z, aimRadians(frame.aim), weapon)
    return true
  }

  /** Own render position: lerp between the last two predicted ticks, plus the decaying error. */
  ownPosition(alpha: number, dtMs: number, out: { x: number; z: number }): void {
    const k = Math.exp(-dtMs / (SMOOTH_MS / 3))
    this.smoothX *= k
    this.smoothZ *= k
    out.x = this.prev.x + (this.pred.x - this.prev.x) * alpha + this.smoothX
    out.z = this.prev.z + (this.pred.z - this.prev.z) * alpha + this.smoothZ
  }

  /** Remote-entity render time (fractional ticks). */
  renderTick(nowMs: number): number {
    if (!this.clock.ready) {
      return this.lastTick
    }
    return this.clock.now(nowMs) - INTERP_TICKS
  }

  /** Every remote sampled at render time. */
  *views(rt: number): Generator<RemoteView> {
    for (const t of this.remotes.values()) {
      const v = t.sample(rt)
      if (v.ready && t.id !== this.you && t.id !== NONE) {
        yield v
      }
    }
  }

  name(id: number): string {
    return this.roster.get(id)?.name ?? (id === this.you ? 'You' : 'Stranger')
  }

  sendControl(text: string): void {
    this.transport?.send(text)
  }
}
