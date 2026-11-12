import { Vec3 } from 'playcanvas'
import {
  SHOT_HIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  SHOT_WALL,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../contract/town.ts'
import { canFire, pressed } from '../ffa/sim/combat.ts'
import {
  BODY_HEIGHT,
  REVOLVER_FIRE_MS,
  RIFLE_FIRE_MS,
  SHOTGUN_FIRE_MS,
} from '../ffa/sim/constants.ts'
import type { Grid } from '../ffa/sim/layout.ts'
import type { Player, SimEvent } from '../ffa/sim/types.ts'
import { haptic } from '../platform/haptics.ts'
import { Buttons, type PlayerInput, type PlayerState } from '../runtime/protocol.ts'
import { getSettings, reducedMotion } from '../settings.ts'
import type { GameApplication } from './application.ts'
import { FrontierAudio } from './frontier-audio.ts'
import { type FrontierSound, preloadFrontierAudio } from './frontier-sounds.ts'
import { poseEye } from './player-pose.ts'
import { ShotFeedback } from './shot-feedback.ts'
import {
  type ShotPoint as Point,
  type ShotTrace,
  type ShotVisuals,
  shotVisuals,
} from './shot-visuals.ts'

interface EffectHooks {
  event?: (event: SimEvent) => void
  fire?: (id: string) => void
  muzzle?: (id: string) => { position: Vec3; direction: Vec3 } | null
  trace?: (from: Vec3, to: Vec3) => Vec3 | null | undefined
  /** The presented riders, the local rider's id, combat state and loadouts, for world audio. */
  riders?: () => ReadonlyMap<string, PlayerState>
  selfId?: () => string
  world?: () => { readonly players: readonly (Player | null)[]; readonly grid: Grid } | undefined
  spurs?: (id: string) => string | undefined
}
interface PendingShot {
  trace: ShotTrace | undefined
  end?: Point
  pellets?: readonly Point[]
}
const REVOLVER = {
  sound: 'revolver',
  interval: REVOLVER_FIRE_MS,
  kick: 0.012,
  flash: 0.09,
} as const
const RIFLE = { sound: 'rifle', interval: RIFLE_FIRE_MS, kick: 0.016, flash: 0.09 } as const
const SHOTGUN = { sound: 'shotgun', interval: SHOTGUN_FIRE_MS, kick: 0.022, flash: 0.14 } as const
type Report = typeof REVOLVER | typeof RIFLE | typeof SHOTGUN
const WEAPON_REPORTS = new Map<number, Report>([
  [WEAPON_RIFLE, RIFLE],
  [WEAPON_SHOTGUN, SHOTGUN],
])
/** Pellet strikes heard per shotgun blast (the rest land under them). */
const PELLET_SOUNDS = 3
/** Poses carry the standing capsule's centre; the boots are half a body below it. */
const sole = (pose: PlayerState): number => pose.y - BODY_HEIGHT / 2
function reportForFlags(flags: number): Report {
  if (flags & SHOT_RIFLE) {
    return RIFLE
  }
  if (flags & SHOT_SHOTGUN) {
    return SHOTGUN
  }
  return REVOLVER
}

/** Native pooled presentation: input fires immediately; only authoritative events confirm impacts. */
export class GameEffects {
  private readonly game: GameApplication
  private readonly hooks: EffectHooks
  private readonly visuals: ShotVisuals
  private readonly audio: FrontierAudio
  /** Each rider's reload and weapon last frame, for the foley edges. */
  private readonly hands = new Map<number, { reload: number; weapon: number }>()
  private readonly abort = new AbortController()
  private readonly start = new Vec3()
  private readonly end = new Vec3()
  readonly ready: Promise<void>
  private readonly predicted = new ShotFeedback<PendingShot>()
  private lastButtons = 0
  private nextShot = 0
  private kick = 0
  private queued:
    | {
        pending: PendingShot
        player: Player
        weapon: number
        report: Report
        muzzle: ReturnType<NonNullable<EffectHooks['muzzle']>>
        input: PlayerInput
      }
    | undefined
  get recoilPitch(): number {
    return this.kick
  }
  static preloadAudio(game: GameApplication): Promise<void> {
    return preloadFrontierAudio(game)
  }
  constructor(game: GameApplication, hooks: EffectHooks = {}) {
    this.game = game
    this.hooks = hooks
    this.visuals = shotVisuals(game)
    game.camera.addComponent('audiolistener')
    this.audio = new FrontierAudio(game, {
      ...(hooks.trace ? { trace: hooks.trace } : {}),
      ...(hooks.world ? { grid: () => hooks.world?.()?.grid } : {}),
    })
    this.ready = this.audio.ready
    if (import.meta.env.DEV) {
      Reflect.set(globalThis, '__frontierAudio', this.audio)
    }
    game.app.on('update', this.update)
    globalThis.addEventListener('pointerup', this.resumeAudio, {
      signal: this.abort.signal,
    })
    globalThis.addEventListener('keydown', this.resumeAudio, {
      signal: this.abort.signal,
    })
  }
  event(event: SimEvent): void {
    this.hooks.event?.(event)
    if (event.type === 'shot') {
      this.confirmShot(event)
    } else if (event.type === 'showdown_call') {
      this.audio.play('bell', null)
    } else if (event.type === 'showdown_fake') {
      this.audio.play(`fake${event.cue % 3}` as FrontierSound, null)
    } else if (event.type === 'explosion') {
      this.audio.play(
        'explosion',
        { x: event.x, y: 0.5, z: event.z },
        { range: 'gun', air: true, space: 0.9 },
      )
    } else if (event.type === 'damage') {
      if (event.attacker === this.self()) {
        this.audio.hitMarker(false)
      }
    } else if (event.type === 'kill') {
      this.killed(event.victim, event.killer)
    } else if (event.type === 'deposit') {
      this.audio.play('deposit', event.player === this.self() ? null : this.riderAt(event.player), {
        range: 'foley',
      })
    } else if (event.type === 'respawn') {
      if (event.player === this.self()) {
        this.audio.play('respawn', null)
      }
    } else if (event.type === 'showdown_start') {
      const mine = [event.showdown.a, event.showdown.b].includes(this.self())
      this.audio.tension(true, mine)
    } else if (event.type === 'showdown_end') {
      this.audio.tension(false, false)
    }
  }
  private self(): number {
    return Number(this.hooks.selfId?.() ?? -1)
  }
  private riderAt(slot: number): Point | null {
    const pose = this.hooks.riders?.().get(String(slot))
    return pose ? { x: pose.x, y: sole(pose) + 1, z: pose.z } : null
  }
  private killed(victim: number, killer: number): void {
    if (killer === this.self() && victim !== killer) {
      this.audio.hitMarker(true)
    }
    const at = this.riderAt(victim)
    if (at) {
      this.audio.play('fall', { ...at, y: at.y - 0.8 }, { range: 'impact', volume: 0.8 })
    }
  }
  /** Bullet strikes for an authoritative shot: the main end, and a few of a blast's pellets. */
  private strikes(event: Extract<SimEvent, { type: 'shot' }>): void {
    if (event.flags & SHOT_HIT) {
      this.audio.impact('body', event.end)
    } else if (event.flags & SHOT_WALL && !this.audio.impactAt(event.end)) {
      this.audio.impact('wood', event.end)
    }
    let heard = 0
    for (const p of event.pellets) {
      if (heard >= PELLET_SOUNDS) {
        break
      }
      if (this.onRider(p)) {
        this.audio.impact('body', p, 0.7)
        heard++
      } else if (this.audio.impactAt(p, 0.6)) {
        heard++
      }
    }
    if (event.shooter !== this.self()) {
      const loud = Boolean(event.flags & SHOT_RIFLE)
      for (const end of [event.end, ...event.pellets.slice(0, 2)]) {
        this.audio.nearMiss(event.origin, end, loud)
      }
    }
  }
  private onRider(p: Point): boolean {
    for (const pose of this.hooks.riders?.().values() ?? []) {
      if (
        Math.hypot(p.x - pose.x, p.z - pose.z) < 0.5 &&
        p.y > sole(pose) - 0.1 &&
        p.y < sole(pose) + BODY_HEIGHT + 0.1
      ) {
        return true
      }
    }
    return false
  }
  private confirmShot(event: Extract<SimEvent, { type: 'shot' }>): void {
    const feedback = this.predicted.confirm(
      event.shooter,
      event.spawnTick,
      event.shotId,
      performance.now(),
    )
    if (feedback.duplicate) {
      return
    }
    const pending = feedback.predicted
    if (!pending) {
      this.hooks.fire?.(String(event.shooter))
    }
    const muzzle = this.hooks.muzzle?.(String(event.shooter))
    const origin = muzzle?.position ?? event.origin
    if (pending) {
      pending.end = event.end
      this.visuals.retarget(pending.trace, event.end)
    } else {
      this.visuals.trace(origin, event.end)
    }
    if (pending && this.queued?.pending === pending) {
      pending.pellets = event.pellets
    } else {
      for (const endpoint of event.pellets) {
        this.visuals.trace(origin, endpoint)
      }
    }
    if (!pending) {
      this.visuals.muzzle(origin)
      this.report(event.shooter, reportForFlags(event.flags).sound, origin)
    }
    if (event.flags & (SHOT_HIT | SHOT_WALL)) {
      this.visuals.impact(event.end, Boolean(event.flags & SHOT_HIT))
    }
    this.strikes(event)
  }
  predictShot(player: Player | null | undefined, input: PlayerInput): boolean {
    const pulled =
      pressed(input.buttons, this.lastButtons, Buttons.fire) || Boolean(player?.fireQueued)
    this.lastButtons = input.buttons
    if (!(player && canFire(player, pulled, player.alive)) || performance.now() < this.nextShot) {
      return false
    }
    const report = WEAPON_REPORTS.get(player.weapon) ?? REVOLVER
    this.nextShot = performance.now() + report.interval
    this.hooks.fire?.(String(player.id))
    const pending: PendingShot = { trace: undefined }
    this.predicted.predict(
      { id: player.id, spawnTick: player.spawnTick, shots: player.stats.shots },
      pending,
      performance.now(),
    )
    this.queued = {
      pending,
      player,
      weapon: player.weapon,
      report,
      muzzle: this.hooks.muzzle?.(String(player.id)) ?? null,
      input: { ...input },
    }
    if (!reducedMotion()) {
      this.kick = report.kick
    }
    if (getSettings().vibration) {
      haptic('shot')
    }
    return true
  }
  /** Resolve the cosmetic ray after the same native motor step used by this frame's camera. */
  flushShot(pose: PlayerState): void {
    const queued = this.queued
    this.queued = undefined
    if (!queued) {
      return
    }
    const { player, input, pending, report } = queued
    const point = poseEye(pose)
    this.start.set(point.x, point.y, point.z)
    const cp = Math.cos(input.pitch)
    this.end.set(
      this.start.x - Math.sin(input.yaw) * cp * 55,
      this.start.y + Math.sin(input.pitch) * 55,
      this.start.z - Math.cos(input.yaw) * cp * 55,
    )
    const hit = this.hooks.trace?.(this.start, this.end)
    const muzzle =
      player.weapon === queued.weapon ? this.hooks.muzzle?.(String(player.id)) : queued.muzzle
    const origin = muzzle?.position ?? this.start
    pending.trace = this.visuals.trace(origin, pending.end ?? hit ?? this.end)
    for (const endpoint of pending.pellets ?? []) {
      this.visuals.trace(origin, endpoint)
    }
    this.visuals.muzzle(origin, report.flash)
    this.report(player.id, report.sound, origin)
  }
  private report(id: number, sound: Report['sound'], at: Point): void {
    this.audio.gunshot(sound, at, id === this.self())
  }
  private readonly resumeAudio = (event: Event): void => {
    if (!event.isTrusted) {
      return
    }
    const manager = this.game.app.soundManager
    if (manager.suspended) {
      return
    }
    // Browser interruption/autoplay state is distinct from native manual suspension.
    const context = manager.context
    if (context?.state !== 'running') {
      void context?.resume().catch(() => undefined)
    }
  }
  private readonly update = (dt: number): void => {
    this.kick = Math.max(0, this.kick - dt * 0.2)
    const riders = this.hooks.riders?.()
    if (!riders) {
      return
    }
    const self = this.hooks.selfId?.() ?? ''
    this.audio.update(dt, riders, self, (id) => this.hooks.spurs?.(id))
    this.handFoley(riders, Number(self))
  }
  /** Reload and weapon-change foley at each rider who just started one. */
  private handFoley(riders: ReadonlyMap<string, PlayerState>, self: number): void {
    for (const p of this.hooks.world?.()?.players ?? []) {
      if (!p) {
        continue
      }
      const was = this.hands.get(p.id)
      this.hands.set(p.id, { reload: p.reloadTicks, weapon: p.weapon })
      if (!(was && p.alive)) {
        continue
      }
      const pose = riders.get(String(p.id))
      if (!pose) {
        continue
      }
      const at = { x: pose.x, y: sole(pose) + 1.1, z: pose.z }
      if (p.weapon !== was.weapon) {
        this.audio.foley('holster', at, p.id === self)
      } else if (p.reloadTicks > 0 && was.reload <= 0) {
        this.audio.foley(
          p.weapon === WEAPON_REVOLVER ? 'reload-revolver' : 'reload-shell',
          at,
          p.id === self,
        )
      }
    }
  }
  reset(): void {
    this.queued = undefined
    this.predicted.clear()
    this.lastButtons = 0
    this.nextShot = 0
    this.kick = 0
    this.visuals.reset()
  }
  destroy(): void {
    this.queued = undefined
    this.abort.abort()
    this.game.app.off('update', this.update)
    this.audio.destroy()
    if (import.meta.env.DEV) {
      Reflect.deleteProperty(globalThis, '__frontierAudio')
    }
    this.hands.clear()
    this.predicted.clear()
    this.visuals.destroy()
  }
}
