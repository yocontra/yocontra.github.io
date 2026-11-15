/**
 * Frontier's world audio on PlayCanvas's native sound system: every sound is a slot on a
 * positional `SoundComponent`, heard by the camera's `AudioListener`. The only extra graph rides on
 * native sound instances through `setExternalNodes`: a low-pass when scenery stands between the
 * listener and the source (or the air has taken the top off a far shot), the send that puts a
 * gunshot into the street's slap or a room's tail (`frontier-space.ts`), and the category bus it
 * is mixed on (`frontier-mix.ts`). Everything that sounds in the town, the window glass included,
 * plays through here and so through the one master limiter.
 *
 * - A firefight is budgeted (`frontier-budget.ts`): the nearest reports keep their close crack;
 *   the rest, and every report past `FAR_SHOT`, collapse into a dull distant boom and the tail.
 * - Frequently heard sounds rotate through their variants (round robin) with pitch and level
 *   jitter, so a volley or a run of steps never repeats a take back to back.
 *
 * - Bullet impacts match the material at the authoritative shot end (`audio-surfaces.ts`).
 * - Every rider within earshot has footsteps on what they stand on (`frontier-feet.ts`).
 * - Shots are the close report and the town's tail; near misses crack past your head.
 * - The town has its beds and its life (`frontier-ambience.ts`), and leans back for a showdown.
 */
import {
  type AppBase,
  type Asset,
  Entity,
  type SoundComponent,
  type SoundInstance,
  Vec3,
} from 'playcanvas'
import type { Grid } from '../ffa/sim/layout.ts'
import type { GameApplication } from './application.ts'
import { type ImpactMaterial, impactMaterial } from './audio-surfaces.ts'
import { FrontierAmbience } from './frontier-ambience.ts'
import { VoiceBudget, variantDeck } from './frontier-budget.ts'
import { FrontierFeet, type RiderPose } from './frontier-feet.ts'
import { FrontierMix, type MixCategory, type MixStats } from './frontier-mix.ts'
import {
  clamp01,
  db,
  type FrontierSound,
  RANGES,
  type Range,
  type RangeName,
  SOUND_CATEGORY,
  SOUNDS,
  type SoundDef,
  slider,
  soundUrl,
} from './frontier-sounds.ts'
import { type Space, SpaceReturns, spaceAt } from './frontier-space.ts'

export interface PlayOptions {
  /** Linear gain on top of the trim and the SFX slider. */
  volume?: number
  pitch?: number
  /** Grid variant; random when absent. */
  variant?: number
  range?: RangeName
  /** Low-pass (Hz) and gain applied when scenery stands between the listener and the source. */
  occlude?: { hz: number; gain: number }
  /** Send into the street slap / room tail. */
  space?: number
  /** Air absorption: a low-pass that falls with distance. */
  air?: boolean
  /** A fixed low-pass, Hz (a distant report's boom). */
  lowpass?: number
  /** The mix bus, when not the sound's own (`SOUND_CATEGORY`). */
  category?: MixCategory
}

export interface Point {
  x: number
  y: number
  z: number
}

export interface Emitter {
  entity: Entity
  sound: SoundComponent
  /** Clock time its last sound ends: a pooled emitter is never moved while it still sounds. */
  busyUntil: number
}

export interface FrontierAudioHooks {
  /** Physics ray from the listener toward a source: the first hit, or null when clear. */
  trace?: (from: Vec3, to: Vec3) => Vec3 | null | undefined
  grid?: () => Grid | undefined
}

const POOL = 32
const NO_FILTER = 19_000
/** How fast the fight's load clears, s (it leans the town back while it lasts). */
const LOAD_DECAY = 0.8
/** Other riders' reports sit under your own gun, as in any shooter's mix. */
const OTHERS = 0.8
const CRACK_GAP = 0.2
/** Past this a report has no close crack left, only the boom and the town's answer, m. */
const FAR_SHOT = 45
/** Variant level jitter (± dB) and, where the call site sets no pitch, pitch jitter (±). */
const GAIN_JITTER = 1.2
const PITCH_JITTER = 0.035
/** Every live `FrontierAudio`, by app: the window glass plays through its town's mix. */
const LIVE = new WeakMap<AppBase, FrontierAudio>()

/** A positional sound's gain at the ear for `range`'s inverse model (1 inside its ref distance). */
const arriving = (d: number, range: Range) =>
  range.ref / (range.ref + range.rolloff * (Math.max(d, range.ref) - range.ref))
/** Ambience and the beds sit this far under a showdown (linear). */
const SHOWDOWN_DUCK = 0.3

/** One played sound, kept in dev builds for probes (`__frontierAudio.log`). */
export interface PlayedSound {
  t: number
  name: FrontierSound
  /** The emitter: `feet-<rider>`, `sound-<n>` (pooled) or the flat one. */
  source: string
  at: Point | null
  distance: number
  volume: number
  occluded: boolean
  lowpass: number
  send: number
  category: MixCategory
  variant: number
}

export class FrontierAudio {
  readonly ready: Promise<void>
  /** Dev builds only: the most recent plays. */
  readonly log: PlayedSound[] = []
  /** Seconds since the engine started; drives every schedule here. */
  clock = 0
  space: Space = { kind: 'open', slap: 0.42 }
  /** Ambience level, 1 at rest and down under a showdown. */
  duck = 1
  private readonly game: GameApplication
  private readonly hooks: FrontierAudioHooks
  private readonly assets = new Map<FrontierSound, Asset>()
  private readonly pool: Emitter[] = []
  private readonly flat: Emitter
  private readonly feet: FrontierFeet
  private readonly ambience: FrontierAmbience
  private readonly from = new Vec3()
  private readonly to = new Vec3()
  private returns: SpaceReturns | null = null
  private mix: FrontierMix | null = null
  private readonly variant = variantDeck()
  /** The nearest few reports keep their crack; tails and strikes are capped the same way. */
  private readonly budgets = {
    report: new VoiceBudget(3, 0.45),
    tail: new VoiceBudget(2, 0.8),
    impact: new VoiceBudget(5, 0.3),
  }
  private spaceDue = 0
  private duckTarget = 1
  private heartDue = Number.POSITIVE_INFINITY
  /** How much gunfire has just reached the ear (decays in `LOAD_DECAY` s). */
  private firing = 0
  /** No second crack before this: a volley reads as one snap past the head, not a rattle. */
  private crackDue = 0
  private destroyed = false as boolean

  constructor(game: GameApplication, hooks: FrontierAudioHooks = {}) {
    this.game = game
    this.hooks = hooks
    this.flat = this.emitter('sound-flat', false)
    this.feet = new FrontierFeet(this)
    this.ambience = new FrontierAmbience(this)
    this.ready = this.load()
    LIVE.set(game.app, this)
  }

  /** The town's world audio for `app`, while it lives. */
  static of(app: AppBase): FrontierAudio | undefined {
    return LIVE.get(app)
  }

  private async load(): Promise<void> {
    await Promise.all(
      (Object.entries(SOUNDS) as [FrontierSound, SoundDef][]).map(async ([name, def]) => {
        try {
          this.assets.set(name, await this.game.loadAudio(soundUrl(def)))
        } catch {
          // A missing optional sound must not prevent joining the town.
        }
      }),
    )
  }

  /** A new emitter entity on the stage (positional unless told otherwise). */
  emitter(name: string, positional = true): Emitter {
    const entity = new Entity(name, this.game.app)
    entity.addComponent('sound', { positional })
    this.game.stage.addChild(entity)
    return { entity, sound: entity.sound as SoundComponent, busyUntil: 0 }
  }

  /** An idle pooled emitter, or the one that frees up soonest. */
  private take(): Emitter {
    let best: Emitter | undefined
    for (const e of this.pool) {
      if (e.busyUntil <= this.clock) {
        return e
      }
      if (!best || e.busyUntil < best.busyUntil) {
        best = e
      }
    }
    if (this.pool.length < POOL || !best) {
      const e = this.emitter(`sound-${this.pool.length}`)
      this.pool.push(e)
      return e
    }
    return best
  }

  /** The running context, or null while suspended or interrupted (sources would queue). */
  get context(): AudioContext | null {
    const manager = this.game.app.soundManager
    if (this.destroyed || manager.suspended || manager.context?.state !== 'running') {
      return null
    }
    return manager.context
  }

  assetOf(name: FrontierSound): Asset | undefined {
    return this.assets.get(name)
  }

  get listener(): Vec3 {
    return this.game.camera.getPosition()
  }

  distance(at: Point): number {
    const ear = this.listener
    return Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z)
  }

  /** Play `name` at `at` (null: centred and unpositioned) from a pooled emitter. */
  play(name: FrontierSound, at: Point | null, o: PlayOptions = {}): SoundInstance | null {
    const range: Range = RANGES[o.range ?? 'impact']
    if (!(this.context && this.assets.has(name)) || (at && this.distance(at) > range.cull)) {
      return null
    }
    const emitter = at ? this.take() : this.flat
    if (at) {
      emitter.entity.setPosition(at.x, at.y, at.z)
    }
    return this.playOn(emitter, name, o)
  }

  /** Play `name` from `emitter` where it stands (footsteps follow their rider's emitter). */
  playOn(emitter: Emitter, name: FrontierSound, o: PlayOptions = {}): SoundInstance | null {
    const asset = this.assets.get(name)
    const ctx = this.context
    if (!(asset && ctx)) {
      return null
    }
    const range: Range = RANGES[o.range ?? 'impact']
    const s = emitter.sound
    const positional = s.positional
    if (positional) {
      s.distanceModel = range.model
      s.refDistance = range.ref
      s.maxDistance = range.max
      s.rollOffFactor = range.rolloff
    }
    const at = emitter.entity.getPosition()
    const occluded = Boolean(positional && o.occlude && this.occluded(at))
    const def: SoundDef = SOUNDS[name]
    const wall = occluded && o.occlude ? o.occlude : { hz: NO_FILTER, gain: 1 }
    const grid = 'grid' in def ? def.grid : undefined
    const variant = grid ? (o.variant ?? this.variant(name, grid.count)) % grid.count : 0
    const jitter = grid ? db((Math.random() * 2 - 1) * GAIN_JITTER) : 1
    const pitch = o.pitch ?? (grid ? 1 + (Math.random() * 2 - 1) * PITCH_JITTER : 1)
    const volume = clamp01((o.volume ?? 1) * db(def.trim) * slider(name) * wall.gain * jitter)
    const instance = this.start(emitter, name, asset, { ...o, volume, variant, pitch })
    if (!instance) {
      return null
    }
    const d = positional ? this.distance(at) : 0
    const air = o.air && d > 30 ? Math.max(1600, 18_000 * (30 / d) ** 1.3) : NO_FILTER
    const send = o.space ? o.space * Math.min(1, 24 / (d + 12)) : 0
    const lowpass = Math.min(wall.hz, air, o.lowpass ?? NO_FILTER)
    const category = o.category ?? SOUND_CATEGORY[name]
    this.chain(ctx, instance, { lowpass, send, category })
    if (import.meta.env.DEV) {
      const where = positional ? { x: at.x, y: at.y, z: at.z } : null
      const source = emitter.entity.name
      this.log.push({
        t: this.clock,
        name,
        source,
        at: where,
        distance: d,
        volume,
        occluded,
        lowpass,
        send,
        category,
        variant,
      })
      this.log.splice(0, Math.max(0, this.log.length - 4000))
    }
    return instance
  }

  private start(
    emitter: Emitter,
    name: FrontierSound,
    asset: Asset,
    o: PlayOptions & { volume: number; variant: number },
  ): SoundInstance | null {
    const sound = emitter.sound
    const slot = sound.slot(name) ?? sound.addSlot(name, { asset: asset.id, overlap: true })
    if (!slot) {
      return null
    }
    const def: SoundDef = SOUNDS[name]
    const grid = def.grid
    slot.startTime = grid ? o.variant * grid.step : 0
    // 0 clears it: the whole file
    slot.duration = grid ? grid.len : 0
    slot.volume = o.volume
    slot.pitch = Math.max(0.25, o.pitch ?? 1)
    const instance = slot.play()
    if (!instance) {
      return null
    }
    const length = (grid ? grid.len : instance.duration || 1) / slot.pitch
    emitter.busyUntil = Math.max(emitter.busyUntil, this.clock + length + 0.05)
    return instance
  }

  /** The mix and its shared returns on this context, made on first use. */
  private buses(ctx: AudioContext): { mix: FrontierMix; returns: SpaceReturns } {
    const mix = this.mix ?? new FrontierMix(ctx, Boolean(import.meta.env.DEV))
    this.mix = mix
    const returns = this.returns ?? new SpaceReturns(ctx, this.space, mix.input('tail'))
    this.returns = returns
    return { mix, returns }
  }

  /**
   * The instance's native external nodes, into its category's bus: an optional low-pass and the
   * space send. Released shortly after the instance ends so finished sounds leave no nodes behind.
   */
  chain(
    ctx: AudioContext,
    instance: SoundInstance,
    { lowpass = NO_FILTER, send = 0, category = 'amb' as MixCategory } = {},
  ): void {
    const { mix, returns: bus } = this.buses(ctx)
    const input = ctx.createGain()
    let dry: AudioNode = input
    if (lowpass < NO_FILTER) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = lowpass
      f.Q.value = 0.6
      input.connect(f)
      dry = f
    }
    dry.connect(mix.input(category))
    const s = send > 0.001 ? ctx.createGain() : null
    if (s) {
      s.gain.value = send * instance.volume
      dry.connect(s)
      s.connect(bus.room)
      s.connect(bus.slap)
    }
    const release = () =>
      setTimeout(() => {
        input.disconnect()
        dry.disconnect()
        s?.disconnect()
      }, 2500)
    instance.once('end', release)
    instance.once('stop', release)
    instance.setExternalNodes(input, mix.mute)
  }

  /** Whether scenery stands between the listener and `at` (a hit well short of the source). */
  occluded(at: Point): boolean {
    const trace = this.hooks.trace
    if (!trace) {
      return false
    }
    this.from.copy(this.listener)
    this.to.set(at.x, at.y, at.z)
    const total = this.from.distance(this.to)
    if (total < 1.5) {
      return false
    }
    const hit = trace(this.from, this.to)
    return Boolean(hit && this.from.distance(hit) < total - 0.9)
  }

  /**
   * The shooter's report. Yours is the close crack (with the town stepping back for it) and the
   * tail. Another rider's keeps its crack while it is among the nearest few in the air and inside
   * `FAR_SHOT`; otherwise it collapses into a dull boom under the tail, as distant fire does.
   */
  gunshot(kind: 'revolver' | 'rifle' | 'shotgun', at: Point, self: boolean, shooter = 0): void {
    const close = { revolver: 'shot', rifle: 'rifle', shotgun: 'shotgun' } as const
    const tailPitch = { revolver: 1, rifle: 0.96, shotgun: 0.86 } as const
    const tailLevel = { interior: 0.6, street: 0.85, open: 0.5 } as const
    // Yours, heard every half second, wanders further; every other rider's gun keeps a voice of
    // its own (±6%), so sixteen riders are not one sample retriggered.
    const voice = 0.94 + ((shooter * 0.618_034) % 1) * 0.12
    const jitter = self ? 0.95 + Math.random() * 0.1 : voice * (0.98 + Math.random() * 0.04)
    const d = this.distance(at)
    const heard = arriving(d, RANGES.gun)
    this.firing += self ? 0.35 : heard
    if (self) {
      this.mix?.ownShot()
    }
    const crack =
      self ||
      (d < FAR_SHOT && this.budgets.report.admit(this.clock, heard * (1 + Math.random() * 0.1)))
    const tail = self || this.budgets.tail.admit(this.clock, heard)
    if (crack) {
      this.play(close[kind], at, {
        range: 'gun',
        pitch: jitter,
        volume: self ? 1 : OTHERS,
        occlude: { hz: 1800, gain: 0.7 },
        air: true,
        space: self ? 0.5 : 0.8,
        category: self ? 'own' : 'gun',
      })
    } else if (tail) {
      // the boom: the report's body with its crack gone, a touch lower
      this.play(close[kind], at, {
        range: 'tail',
        pitch: jitter * 0.86,
        volume: 0.55,
        lowpass: 700 + 900 * Math.min(1, 30 / Math.max(30, d)),
        category: 'tail',
      })
    }
    if (tail) {
      this.play('tail', at, {
        range: 'tail',
        pitch: tailPitch[kind] * jitter * (this.space.kind === 'interior' ? 0.9 : 1),
        volume: tailLevel[this.space.kind] * (self ? 0.75 : 0.8),
        air: true,
        space: 0.25,
      })
    }
    if (kind === 'rifle') {
      // the lever cycling the next round
      setTimeout(() => this.play('lever', at, { range: 'foley', volume: self ? 0.8 : 0.6 }), 380)
    }
  }

  /** A confirmed bullet strike on scenery or a rider. Glass is the shatter's (`glass_break`). */
  impact(material: ImpactMaterial, at: Point, volume = 1): void {
    if (material === 'glass') {
      return
    }
    const heard = arriving(this.distance(at), RANGES.impact) * volume
    if (!this.budgets.impact.admit(this.clock, material === 'body' ? heard * 2 : heard)) {
      return
    }
    this.play(material, at, {
      range: 'impact',
      volume,
      pitch: 0.93 + Math.random() * 0.14,
      occlude: { hz: 1200, gain: 0.55 },
    })
  }

  /** Strike whatever is at `at`; null (and silence) when the shot ended in the air. */
  impactAt(at: Point, volume = 1): ImpactMaterial | null {
    const material = impactMaterial(at, this.hooks.grid?.())
    if (material) {
      this.impact(material, at, volume)
    }
    return material
  }

  /** A shot passing within 3 m of the listener: the crack at the nearest point, then the whiz. */
  nearMiss(origin: Point, end: Point, loud: boolean): boolean {
    const ear = this.listener
    const dx = end.x - origin.x
    const dy = end.y - origin.y
    const dz = end.z - origin.z
    const len2 = dx * dx + dy * dy + dz * dz
    if (len2 < 1) {
      return false
    }
    const t = ((ear.x - origin.x) * dx + (ear.y - origin.y) * dy + (ear.z - origin.z) * dz) / len2
    if (t <= 0.05 || t >= 0.97) {
      return false
    }
    const at = { x: origin.x + dx * t, y: origin.y + dy * t, z: origin.z + dz * t }
    const miss = this.distance(at)
    if (miss > 3 || this.clock < this.crackDue) {
      return false
    }
    this.crackDue = this.clock + CRACK_GAP
    const k = 1 - miss / 3
    this.play('crack', at, { range: 'near', volume: (loud ? 0.85 : 0.65) * (0.5 + 0.5 * k) })
    setTimeout(() => this.play('flyby', at, { range: 'near', volume: 0.2 + 0.7 * k }), 25)
    return true
  }

  /** Hit marker and kill confirm: dry and centred, the shooter's alone. */
  hitMarker(kill: boolean): void {
    this.play('hitMarker', null, { volume: 0.9, pitch: 0.97 + Math.random() * 0.06 })
    if (kill) {
      setTimeout(() => this.play('kill', null), 70)
    }
  }

  /** Reload and weapon foley, close to the rider. */
  foley(what: 'reload-revolver' | 'reload-shell' | 'holster', at: Point, self: boolean): void {
    const volume = self ? 1 : 0.6
    if (what === 'holster') {
      this.play('holster', at, { range: 'foley', volume })
      setTimeout(() => this.play('cock', at, { range: 'foley', volume: volume * 0.8 }), 260)
      return
    }
    this.play(what === 'reload-shell' ? 'shell' : 'reload', at, {
      range: 'foley',
      volume,
      pitch: 0.96 + Math.random() * 0.08,
      occlude: { hz: 900, gain: 0.5 },
    })
  }

  /** A pane bursting where the bullet crossed it (`glass-shards.ts`). */
  glass(at: Point): void {
    this.play('glass', at, { range: 'impact', occlude: { hz: 2200, gain: 0.6 }, space: 0.3 })
  }

  /** Lean the town back for a showdown, with your heart under it when it is yours. */
  tension(on: boolean, mine: boolean): void {
    this.mix?.setShowdown(on)
    this.duckTarget = on ? SHOWDOWN_DUCK : 1
    this.heartDue = on && mine ? this.clock + 0.2 : Number.POSITIVE_INFINITY
  }

  /** Per frame: the listener's space, the beds and life, the heart and every nearby rider's feet. */
  update(
    dt: number,
    riders: ReadonlyMap<string, RiderPose>,
    self: string,
    spursOf: (id: string) => string | undefined,
  ): void {
    this.clock += dt
    this.firing *= Math.exp(-dt / LOAD_DECAY)
    if (!this.context) {
      return
    }
    if (this.clock >= this.spaceDue) {
      this.spaceDue = this.clock + 0.25
      const next = spaceAt(this.listener)
      if (next.kind !== this.space.kind || Math.abs(next.slap - this.space.slap) > 0.01) {
        this.space = next
        this.returns?.apply(next)
      }
    }
    this.duck += (this.duckTarget - this.duck) * Math.min(1, dt * 3)
    this.mix?.setFight(this.firing / 2.5)
    this.mix?.meter(this.clock)
    this.ambience.update()
    if (this.clock >= this.heartDue) {
      this.play('heart', null, { volume: 0.8 })
      setTimeout(() => this.play('heart', null, { volume: 0.5, pitch: 0.92 }), 170)
      this.heartDue = this.clock + 60 / 78
    }
    this.feet.update(dt, riders, self, spursOf)
  }

  /** Dev meters: per-category levels and what each budget let through. */
  /** A mix category's processed output (dev tools record it as a stem). */
  stem(category: MixCategory): AudioNode | null {
    return this.mix?.stem(category) ?? null
  }

  mixStats(): MixStats {
    const budget: MixStats['budget'] = {}
    for (const [name, b] of Object.entries(this.budgets)) {
      budget[name] = { played: b.played, dropped: b.dropped }
    }
    const none = { max: 0, mean: 0 }
    const reduction = this.mix?.reductionStats() ?? { limiter: none, glue: none }
    return { rms: this.mix?.stats() ?? {}, budget, reduction }
  }

  destroy(): void {
    this.destroyed = true
    if (LIVE.get(this.game.app) === this) {
      LIVE.delete(this.game.app)
    }
    for (const e of [...this.pool, this.flat]) {
      e.entity.destroy()
    }
    this.pool.length = 0
    this.feet.destroy()
    this.ambience.destroy()
    this.returns?.dispose()
    this.mix?.dispose()
  }
}
