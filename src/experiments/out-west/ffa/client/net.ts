// biome-ignore-all lint/style/noExcessiveLinesPerFile: prediction, reconciliation, interpolation and events are one netcode file
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `haveSelf` flips on the first snapshot; Biome narrows it to its initialiser
/**
 * The Frontier client netcode: send-on-change input (`InputBatcher`) paced by `TickClock`,
 * own-player prediction with the server's exact `stepMove`, reconciliation on `lastInputSeq`
 * (rebase on the server's move state, replay unacknowledged frames, and carry the difference as a
 * visual offset that a critically damped spring removes in ~200 ms; only teleports snap),
 * interpolation of everyone else at a jitter-adaptive delay on a smoothed clock, and the event
 * stream.
 */
import {
  BTN_FIRE,
  CONTRACT_VERSION,
  INPUT_LEAD_NONE,
  MOVE_SPRINTING,
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
import { InputBatcher, quantizeAim, quantizePitch } from '../sim/input.ts'
import { buildGrid, type Grid, TOWN } from '../sim/layout.ts'
import { aimRadians, stepMove, vaulting } from '../sim/move.ts'
import type { MoveState } from '../sim/types.ts'
import { RemoteTrack, type RemoteView, ServerClock } from './interp.ts'
import { PersistentTownState, validPersistentState } from './persistent-state.ts'
import { type RagdollImpact, ShotImpacts } from './shot-impact.ts'
import { TickClock } from './tick-clock.ts'
import type { Transport } from './transport.ts'

/**
 * Corrections under this are blended out; larger ones are teleports (respawn, a knock across the
 * street) and snap. A tick of running is 0.28 m and a roll tick 0.6 m, so a frame applied a tick
 * late, or a roll that started a tick early, must blend, not jump.
 */
const SMOOTH_UNDER_M = 2.5
/**
 * Stiffness of the correction spring (rad/s): critically damped, so the offset leaves with no
 * velocity kick (an exponential decay would add its whole size ÷ τ to the speed in one frame). 90%
 * gone in ~190 ms; a 0.28 m correction moves you at most 2 m/s faster or slower on the way.
 */
const SMOOTH_OMEGA = 20
const MAX_PENDING = 64
/** Render-clock slew toward its target (per tick of error), and its cap (±10% playback speed). */
const RT_GAIN = 0.5
const RT_MAX_SLEW = 0.1
/** Render clock this far (ticks) from its target: jump instead of slewing (a stall, a resync). */
const RT_JUMP_TICKS = 4

export interface Intent {
  /** −127..127, +x east, +z south. */
  moveX: number
  moveZ: number
  /** u16 turns. */
  aim: number
  buttons: number
  /** Authoritative aim pitch, ±127 = ±90°. */
  pitch?: number
}

export interface NetHandlers {
  onWelcome: (you: number) => void
  /** A terminal protocol/state refusal; the connection is closed without retrying. */
  onIncompatible?: (message: string) => void
  /** A complete authoritative replacement is ready for silent scene reconciliation. */
  onPersistentState?: () => void
  onControl: (msg: ServerControl) => void
  onEvent: (ev: WireEvent, tick: number) => void
  /** A shot this client predicted (muzzle flash, tracer and sound before the server answers). */
  onPredictedShot: (x: number, z: number, aim: number, weapon: number, pitch: number) => void
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
  readonly persistent = new PersistentTownState()
  private readonly impacts = new ShotImpacts()
  readonly clock = new ServerClock()
  /** Paces the input ticks so frames reach the server just in time (see `tick-clock.ts`). */
  readonly tickClock = new TickClock()
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
  /** Correction telemetry (dev trace): smoothed and snapped counts, total and worst size (m). */
  readonly corr = { smooth: 0, snap: 0, sumM: 0, maxM: 0 }
  /** The newest server-acknowledged own position (m). */
  srvX = 0
  srvZ = 0
  snaps = 0
  bytesIn = 0
  bytesOut = 0
  /** Predicted own move state after the newest local tick, and the one before (render lerp). */
  readonly pred: MoveState = {
    x: 0,
    z: 0,
    y: 0,
    roof: 0,
    climbTicks: 0,
    climbDeck: 0,
    climbDir: 0,
    fallTicks: 0,
    fallTotal: 0,
    fallFromX: 0,
    fallFromZ: 0,
    fallFromY: 0,
    fallToX: 0,
    fallToY: 0,
    fallToZ: 0,
    rollTicks: 0,
    rollCooldown: 0,
    rollDirX: 1,
    rollDirZ: 0,
    jumpTicks: 0,
    jumpCooldown: 0,
    vaultStep: 0,
    vaultAim: 0,
    sprinting: false,
    sprintLock: 0,
    sprintOut: 0,
    slideTicks: 0,
    slideCooldown: 0,
    slideAim: 0,
    airX: 0,
    airZ: 0,
    vy: 0,
    grounded: true,
    support: 0,
    airPeakY: 0,
    mantleTicks: 0,
    mantleFromX: 0,
    mantleFromY: 0,
    mantleFromZ: 0,
    mantleToX: 0,
    mantleToY: 0,
    mantleToZ: 0,
    fallDamage: 0,
  }
  readonly prev: MoveState = { ...this.pred }
  /** A trigger pull waiting out the sprint-to-fire delay (mirrors the server's `fireQueued`). */
  private queuedShot = false
  /** The visual correction offset (m) and its velocity (m/s): what the spring still has to remove. */
  private offX = 0
  private offZ = 0
  private offVX = 0
  private offVZ = 0
  /** Aim of the newest predicted frame (radians). */
  private predAim = 0
  /** The smoothed remote-entity render clock (fractional ticks) and when it last advanced. */
  private rt = 0
  private rtAt = -1
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
  private welcomeAccepted = false
  private rejected = false

  constructor(handlers: NetHandlers) {
    this.handlers = handlers
  }

  attach(t: Transport): void {
    this.transport = t
  }

  /** A reconnect: the server sends `MSG_FULL_RESET` too, but never trust a stale baseline. */
  reset(): void {
    this.welcomeAccepted = false
    this.persistent.ready = false
    this.clearBaseline()
  }

  private clearBaseline(): void {
    this.impacts.clear()
    this.baseline.clear()
    this.remotes.clear()
    this.pending.length = 0
    this.tickClock.reset()
  }

  /** The current input tick period (ms): `TICK_MS`, nudged by `TickClock`. */
  get tickPeriod(): number {
    return this.tickClock.period
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
    if (this.rejected) {
      return
    }
    if (typeof data === 'string') {
      this.bytesIn += data.length
      this.onText(data)
      return
    }
    this.bytesIn += data.byteLength
    const kind = new Uint8Array(data)[0]
    if (kind === MSG_FULL_RESET) {
      this.clearBaseline()
      return
    }
    if (kind !== MSG_SNAPSHOT || !this.welcomeAccepted) {
      return
    }
    const snap = decodeSnapshot(data, this.baseline)
    if (!snap) {
      return
    }
    this.snaps++
    this.lastTick = snap.tick
    this.persistent.advance(snap.tick)
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
    const skip = this.tickClock.observe(
      snap.inputLead === INPUT_LEAD_NONE ? null : snap.inputLead,
      nowMs,
    )
    if (skip > 0) {
      this.send(this.batcher.skip(skip), nowMs)
    }
    this.impacts.remember(snap.events, snap.tick, nowMs)
    for (const ev of snap.events) {
      if (this.persistent.event(ev, snap.tick)) {
        this.handlers.onEvent(ev, snap.tick)
      }
    }
  }

  takeRagdollImpact(victim: number, killer: number, nowMs: number): RagdollImpact | null {
    return this.impacts.take(victim, killer, this.lastTick, nowMs)
  }

  private send(out: { seq: number; frames: WireFrame[] } | null, nowMs: number): void {
    if (!(out && this.transport && this.welcomeAccepted)) {
      return
    }
    const bytes = encodeInput(this.writer, {
      seq: out.seq,
      ackTick: this.lastTick & 0xff_ff,
      ackAgeMs: Math.round(nowMs - this.lastArrival),
      frames: out.frames,
    })
    this.bytesOut += bytes.byteLength
    this.transport.send(bytes)
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
    if (!msg || typeof msg !== 'object') {
      return
    }
    if (msg.type !== 'welcome' && !this.welcomeAccepted) {
      return
    }
    switch (msg.type) {
      case 'welcome':
        if (msg.contractVersion !== CONTRACT_VERSION) {
          this.reject('The town is updating. Refresh the page in a moment to play.')
          return
        }
        this.welcomeAccepted = true
        this.impacts.clear()
        this.persistent.ready = false
        this.you = msg.you
        this.lobbyId = msg.lobbyId
        this.banked = msg.banked
        this.roster.clear()
        for (const r of msg.roster) {
          this.roster.set(r.id, r)
        }
        this.handlers.onWelcome(msg.you)
        break
      case 'town_state':
        if (!validPersistentState(msg.state, this.grid, TOWN.pickups.length)) {
          this.reject('The town could not be loaded. Refresh the page to try again.')
          return
        }
        this.persistent.replace(msg.state)
        this.handlers.onPersistentState?.()
        break
      case 'roster_add':
        this.roster.set(msg.entry.id, msg.entry)
        break
      case 'roster_remove':
        this.impacts.remove(msg.id)
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

  private reject(message: string): void {
    this.impacts.clear()
    this.rejected = true
    this.welcomeAccepted = false
    this.persistent.ready = false
    this.handlers.onIncompatible?.(message)
    this.transport?.close()
  }

  /**
   * Rebase on the server's move state and replay every frame it hasn't consumed yet. The rendered
   * position must not move when that happens: both ends of the tick lerp shift with the
   * prediction, and the difference becomes the spring's offset.
   */
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
      y: s.y,
      roof: s.roof,
      climbTicks: s.climbTicks,
      climbDeck: s.climbDeck,
      climbDir: s.climbDir,
      fallTicks: s.fallTicks,
      fallTotal: s.fallTotal,
      fallFromX: s.fallFromX,
      fallFromZ: s.fallFromZ,
      fallFromY: s.fallFromY,
      fallToX: s.fallToX,
      fallToY: s.fallToY,
      fallToZ: s.fallToZ,
      rollTicks: s.rollTicks,
      rollCooldown: s.rollCooldown,
      rollDirX: Math.cos(rollRad),
      rollDirZ: Math.sin(rollRad),
      jumpTicks: s.jumpTicks,
      jumpCooldown: s.jumpCooldown,
      vaultStep: s.vaultStep / 100,
      vaultAim: s.vaultAim,
      sprinting: (s.moveFlags & MOVE_SPRINTING) !== 0,
      sprintLock: s.sprintLock,
      sprintOut: s.sprintOut,
      slideTicks: s.slideTicks,
      slideCooldown: s.slideCooldown,
      slideAim: s.slideAim,
      airX: s.airX / 100,
      airZ: s.airZ / 100,
      vy: s.vy,
      grounded: s.grounded !== 0,
      support: s.support,
      airPeakY: s.airPeakY,
      mantleTicks: s.mantleTicks,
      mantleFromX: 0,
      mantleFromY: 0,
      mantleFromZ: 0,
      mantleToX: 0,
      mantleToY: 0,
      mantleToZ: 0,
      fallDamage: 0,
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
    this.srvX = s.x / POS_SCALE
    this.srvZ = s.z / POS_SCALE
    if (err > 1e-4) {
      this.corr.sumM += err
      this.corr.maxM = Math.max(this.corr.maxM, err)
      if (err < SMOOTH_UNDER_M) {
        this.corr.smooth++
      } else {
        this.corr.snap++
      }
    }
    if (err < SMOOTH_UNDER_M) {
      this.prev.x -= ex
      this.prev.z -= ez
      this.offX += ex
      this.offZ += ez
    } else {
      // A teleport: snap, with no lerp across it.
      this.offX = 0
      this.offZ = 0
      this.offVX = 0
      this.offVZ = 0
      Object.assign(this.prev, m)
    }
    Object.assign(this.pred, m)
  }

  /**
   * One 20 Hz client tick: number the frame, send it if the batcher says so, and predict it.
   * `renderTick` is the remote-entity time on screen (for the server's hit rewind).
   */
  tick(intent: Intent, renderTick: number, nowMs: number): void {
    if (!this.welcomeAccepted) {
      return
    }
    const viewTick = Math.max(0, Math.floor(renderTick))
    const frame: WireFrame = {
      moveX: intent.moveX,
      moveZ: intent.moveZ,
      aim: quantizeAim(intent.aim),
      buttons: intent.buttons,
      viewTick: viewTick & 0xff_ff,
      viewFrac: Math.round((renderTick - viewTick) * 255),
      pitch: quantizePitch(intent.pitch ?? 0),
    }
    const seq = this.batcher.nextSeq
    this.send(this.batcher.push(frame), nowMs)
    this.predAim = aimRadians(frame.aim)
    if (!this.haveSelf) {
      this.prevButtons = frame.buttons
      return
    }
    Object.assign(this.prev, this.pred)
    // The server moves first, then fires (a pull that ends a sprint waits for the gun to come up).
    stepMove(this.grid, this.pred, {
      moveX: frame.moveX,
      moveZ: frame.moveZ,
      aim: frame.aim,
      buttons: frame.buttons,
      prevButtons: this.prevButtons,
      canMove: this.canMove,
    })
    const shot = this.predictShot(frame, nowMs)
    this.pending.push({ seq, frame, shot })
    if (this.pending.length > MAX_PENDING) {
      this.pending.shift()
    }
    this.prevButtons = frame.buttons
  }

  /** Mirror the server's fire checks closely enough to flash the muzzle without waiting. */
  private predictShot(frame: WireFrame, nowMs: number): boolean {
    const s = this.self
    const pull =
      ((frame.buttons & BTN_FIRE) !== 0 && (this.prevButtons & BTN_FIRE) === 0) || this.queuedShot
    this.queuedShot = pull && this.canMove && this.pred.sprintOut > 0
    if (!(pull && s && this.canMove) || this.queuedShot) {
      return false
    }
    const blocked =
      this.pred.sprinting ||
      this.pred.rollTicks > 0 ||
      vaulting(this.pred) ||
      (s.reloadTicks > 0 && this.weapon.weapon === WEAPON_REVOLVER) ||
      this.ammo <= 0 ||
      nowMs < this.localCooldownUntil
    if (blocked) {
      return false
    }
    const weapon = this.weapon.weapon
    this.localCooldownUntil = nowMs + (FIRE_MS[weapon] ?? REVOLVER_FIRE_MS) - TICK_MS / 2
    this.predictedShots++
    this.handlers.onPredictedShot(
      this.pred.x,
      this.pred.z,
      aimRadians(frame.aim),
      weapon,
      frame.pitch ?? 0,
    )
    return true
  }

  /**
   * Your pose on screen, the one thing every camera mode should follow: the lerp between the last
   * two predicted ticks at `alpha` (the input accumulator ÷ `tickPeriod`), plus the correction
   * offset as the spring removes it. `yaw` is the aim of the newest predicted frame (radians).
   * Call once per rendered frame with that frame's `dtMs`.
   */
  localRenderPose(
    alpha: number,
    dtMs: number,
    out: { x: number; z: number; y: number; yaw: number },
  ): void {
    const dt = Math.max(0, dtMs) / 1000
    const e = Math.exp(-SMOOTH_OMEGA * dt)
    const tx = (this.offVX + SMOOTH_OMEGA * this.offX) * dt
    const tz = (this.offVZ + SMOOTH_OMEGA * this.offZ) * dt
    this.offX = (this.offX + tx) * e
    this.offZ = (this.offZ + tz) * e
    this.offVX = (this.offVX - SMOOTH_OMEGA * tx) * e
    this.offVZ = (this.offVZ - SMOOTH_OMEGA * tz) * e
    out.x = this.prev.x + (this.pred.x - this.prev.x) * alpha + this.offX
    out.z = this.prev.z + (this.pred.z - this.prev.z) * alpha + this.offZ
    out.y = this.prev.y + (this.pred.y - this.prev.y) * alpha
    out.yaw = this.predAim
  }

  /**
   * Remote-entity render time (fractional ticks) for a frame at `nowMs`: the server clock minus the
   * jitter-adaptive interpolation delay, slewed (±10% playback speed) rather than stepped when the
   * clock estimate or the delay moves, so remote riders never hop.
   */
  renderTick(nowMs: number): number {
    if (!this.clock.ready) {
      return this.lastTick
    }
    const target = this.clock.now(nowMs) - this.clock.delay
    if (this.rtAt < 0 || Math.abs(target - this.rt) > RT_JUMP_TICKS) {
      this.rt = target
    } else {
      const err = target - this.rt
      const rate = 1 + Math.max(-RT_MAX_SLEW, Math.min(RT_MAX_SLEW, err * RT_GAIN))
      this.rt += ((nowMs - this.rtAt) / TICK_MS) * rate
    }
    this.rtAt = nowMs
    return this.rt
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
