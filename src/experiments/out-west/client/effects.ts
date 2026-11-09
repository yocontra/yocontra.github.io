import { type Asset, Entity, Vec3 } from 'playcanvas'
import {
  SHOT_HIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  SHOT_WALL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../contract/town.ts'
import { canFire, pressed } from '../ffa/sim/combat.ts'
import { REVOLVER_FIRE_MS, RIFLE_FIRE_MS, SHOTGUN_FIRE_MS } from '../ffa/sim/constants.ts'
import type { Player, SimEvent } from '../ffa/sim/types.ts'
import { haptic } from '../platform/haptics.ts'
import { Buttons, type PlayerInput, type PlayerState } from '../runtime/protocol.ts'
import { getSettings, reducedMotion } from '../settings.ts'
import type { GameApplication } from './application.ts'
import { poseEye } from './player-pose.ts'
import { ShotFeedback } from './shot-feedback.ts'
import {
  type ShotPoint as Point,
  type ShotTrace,
  type ShotVisuals,
  shotVisuals,
} from './shot-visuals.ts'

interface EffectHooks {
  fire?: (id: string) => void
  muzzle?: (id: string) => { position: Vec3; direction: Vec3 } | null
  trace?: (from: Vec3, to: Vec3) => Vec3 | null | undefined
}
interface PendingShot {
  trace: ShotTrace | undefined
  end?: Point
  pellets?: readonly Point[]
}
const REVOLVER = { sound: 'shot', interval: REVOLVER_FIRE_MS, kick: 0.012, flash: 0.09 }
const RIFLE = { sound: 'rifle', interval: RIFLE_FIRE_MS, kick: 0.016, flash: 0.09 }
const SHOTGUN = { sound: 'shotgun', interval: SHOTGUN_FIRE_MS, kick: 0.022, flash: 0.14 }
const WEAPON_REPORTS = new Map([
  [WEAPON_RIFLE, RIFLE],
  [WEAPON_SHOTGUN, SHOTGUN],
])
const sounds = new WeakMap<GameApplication, Promise<Map<string, Asset>>>()
function loadSounds(game: GameApplication): Promise<Map<string, Asset>> {
  const previous = sounds.get(game)
  if (previous) {
    return previous
  }
  const assets = new Map<string, Asset>()
  const ready = Promise.all(
    [
      ['shot', 'rev_close'],
      ['tail', 'rev_tail'],
      ['rifle', 'rifle'],
      ['shotgun', 'shotgun'],
      ['reload', 'shotgun_load'],
      ['hit', 'bodyfall'],
      ['coin', 'coin'],
      ['deposit', 'deposit'],
      ['bell', 'bell'],
      ['fake0', 'crow'],
      ['fake1', 'cock'],
      ['fake2', 'door'],
      ['explosion', 'explosion'],
      ['respawn', 'respawn'],
    ].map(async ([name, file]) => {
      try {
        const asset = await game.loadAudio(`/experiments/out-west/3d/sfx/${file}.m4a`)
        if (name) {
          assets.set(name, asset)
        }
      } catch {
        // A missing optional report must not prevent joining the town.
      }
    }),
  ).then(() => assets)
  sounds.set(game, ready)
  return ready
}
function reportForFlags(flags: number) {
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
  private readonly emitters = new Map<number, Entity>()
  private readonly soundAssets = new Map<string, Asset>()
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
        report: typeof REVOLVER
        muzzle: ReturnType<NonNullable<EffectHooks['muzzle']>>
        input: PlayerInput
      }
    | undefined
  get recoilPitch(): number {
    return this.kick
  }
  static preloadAudio(game: GameApplication): Promise<void> {
    return loadSounds(game).then(() => undefined)
  }
  constructor(game: GameApplication, hooks: EffectHooks = {}) {
    this.game = game
    this.hooks = hooks
    this.visuals = shotVisuals(game)
    game.camera.addComponent('audiolistener')
    this.ready = loadSounds(game).then((assets) => {
      if (!this.abort.signal.aborted) {
        for (const [name, asset] of assets) {
          this.soundAssets.set(name, asset)
        }
      }
    })
    game.app.on('update', this.update)
    globalThis.addEventListener('pointerup', this.resumeAudio, {
      signal: this.abort.signal,
    })
    globalThis.addEventListener('keydown', this.resumeAudio, {
      signal: this.abort.signal,
    })
  }
  event(event: SimEvent): void {
    if (event.type === 'shot') {
      this.confirmShot(event)
    } else if (event.type === 'showdown_call') {
      this.play(-1, 'bell', this.game.camera.getPosition())
    } else if (event.type === 'showdown_fake') {
      this.play(-1, `fake${event.cue % 3}`, this.game.camera.getPosition())
    } else if (event.type === 'explosion') {
      this.play(event.by, 'explosion', { x: event.x, y: 0.5, z: event.z })
    } else if (event.type === 'kill') {
      this.play(-1, 'hit', this.game.camera.getPosition())
    } else if (event.type === 'deposit') {
      this.play(event.player, 'deposit', this.game.camera.getPosition())
    } else if (event.type === 'respawn') {
      this.play(event.player, 'respawn', this.game.camera.getPosition())
    }
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
  private report(id: number, sound: string, at: Point): void {
    this.play(id, sound, at)
    this.play(id, 'tail', at)
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
  private play(id: number, name: string, position: Point): void {
    const asset = this.soundAssets.get(name)
    if (!asset) {
      return
    }
    // Suspended/interrupted contexts do not finish sources, so overlapping one-shots would queue.
    const manager = this.game.app.soundManager
    if (manager.suspended || manager.context?.state !== 'running') {
      return
    }
    let entity = this.emitters.get(id)
    if (!entity) {
      entity = new Entity(`sound-${id}`, this.game.app)
      entity.addComponent('sound', { positional: true, refDistance: 5, maxDistance: 65 })
      this.game.stage.addChild(entity)
      this.emitters.set(id, entity)
    }
    entity.setPosition(position.x, position.y, position.z)
    const sound = entity.sound
    if (!sound) {
      return
    }
    if (!sound.slot(name)) {
      sound.addSlot(name, { asset: asset.id, overlap: true, volume: 0.7 })
    }
    const slot = sound.slot(name)
    if (slot) {
      slot.volume = name === 'bell' ? 1 : getSettings().sfx * (name === 'tail' ? 0.25 : 0.7)
    }
    sound.play(name)
  }
  private readonly update = (dt: number): void => {
    this.kick = Math.max(0, this.kick - dt * 0.2)
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
    for (const emitter of this.emitters.values()) {
      emitter.destroy()
    }
    this.predicted.clear()
    this.emitters.clear()
    this.visuals.destroy()
  }
}
