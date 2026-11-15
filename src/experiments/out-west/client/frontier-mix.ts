/**
 * Frontier's mix: every native sound instance lands on one category bus, each with its own level
 * and EQ carve, and the buses meet in a master limiter and soft clip. Gunfire (your own report,
 * other riders' reports and the town's tails) is glued by its own compressor, so a volley is held
 * together without pumping the footsteps, the impacts, the feedback or the town. Footsteps keep a
 * presence lift in the band the gun tails are carved out of: a rider closing in stays audible
 * through a firefight, as in any competitive shooter.
 *
 * Ducking is driven from the game, not a detector: your own shot dips the other riders' reports,
 * the tails and the town for a moment; sustained gunfire leans the town back, and it swells again
 * between bursts.
 */
import { db, softClipCurve } from '../audio/math.ts'

export type MixCategory =
  | 'own'
  | 'gun'
  | 'tail'
  | 'impact'
  | 'feet'
  | 'foley'
  | 'crack'
  | 'ui'
  | 'amb'
  | 'cue'

interface Carve {
  type: BiquadFilterType
  hz: number
  q?: number
  gain?: number
}

interface CategorySpec {
  /** Bus level, dB: the category's loudness target relative to the others. */
  level: number
  /** EQ that keeps the category out of the others' way. */
  carve: readonly Carve[]
  /** Glued with the gunfire (`weapons`) or straight into the master limiter. */
  into: 'weapons' | 'master'
}

/**
 * Levels and carves per category. The 2.5–4 kHz band is where a boot's heel click and a hit
 * marker's tick live: the reports and tails give some of it up, the feet are lifted there, and the
 * tails also lose the top end that would smear every transient after them. Only your own report
 * keeps its sub: the others' and the tails' low end would stack into a wall in a volley.
 */
export const CATEGORIES: Readonly<Record<MixCategory, CategorySpec>> = {
  own: {
    level: 0,
    carve: [
      { type: 'highpass', hz: 35 },
      { type: 'peaking', hz: 3500, q: 0.9, gain: -3 },
    ],
    into: 'master',
  },
  gun: {
    level: -6,
    carve: [
      { type: 'highpass', hz: 90 },
      { type: 'peaking', hz: 3000, q: 0.7, gain: -6 },
    ],
    into: 'weapons',
  },
  tail: {
    level: -11,
    carve: [
      { type: 'highpass', hz: 150 },
      { type: 'peaking', hz: 3000, q: 0.6, gain: -9 },
      { type: 'highshelf', hz: 6500, gain: -6 },
    ],
    into: 'weapons',
  },
  impact: {
    level: -3,
    carve: [
      { type: 'highpass', hz: 60 },
      { type: 'peaking', hz: 300, q: 1, gain: -2 },
      { type: 'peaking', hz: 3200, q: 1.2, gain: -4 },
    ],
    into: 'master',
  },
  feet: {
    level: 0,
    carve: [
      { type: 'highpass', hz: 90 },
      { type: 'peaking', hz: 3200, q: 1.2, gain: 4 },
    ],
    into: 'master',
  },
  foley: { level: -1, carve: [{ type: 'highpass', hz: 120 }], into: 'master' },
  crack: { level: 0, carve: [{ type: 'highpass', hz: 300 }], into: 'master' },
  ui: { level: 0, carve: [], into: 'master' },
  amb: {
    level: 6,
    carve: [
      { type: 'highpass', hz: 60 },
      { type: 'peaking', hz: 3000, q: 0.8, gain: -3 },
    ],
    into: 'master',
  },
  cue: { level: 0, carve: [], into: 'master' },
}

/** A dip: how deep (dB) and how fast it lets go (s). */
interface Dip {
  depth: number
  release: number
}
/** Your own shot pushes these back for a moment. */
const OWN_SHOT: Partial<Record<MixCategory, Dip>> = {
  gun: { depth: -1.5, release: 0.12 },
  tail: { depth: -2, release: 0.2 },
}
/** A showdown leans the town and the far fight back. */
const SHOWDOWN: Partial<Record<MixCategory, number>> = { amb: -9, tail: -4, gun: -3 }
/** Level changes under sustained fire: foreground priority only when the fight needs it. */
const FIGHT: Partial<Record<MixCategory, number>> = { own: 4, amb: -1.5, tail: -8, gun: -2 }
const FIGHT_RELEASE = 0.9

function glue(ctx: AudioContext): DynamicsCompressorNode {
  const c = ctx.createDynamicsCompressor()
  c.threshold.value = -18
  c.knee.value = 8
  c.ratio.value = 2
  c.attack.value = 0.012
  c.release.value = 0.25
  return c
}

/** Bound transients and leave output headroom for reconstruction and the separate music bus. */
function limiter(ctx: AudioContext): {
  input: GainNode
  lim: DynamicsCompressorNode
  output: AudioNode
} {
  const input = ctx.createGain()
  input.gain.value = db(-3)
  const lim = ctx.createDynamicsCompressor()
  lim.threshold.value = -2
  lim.knee.value = 0
  lim.ratio.value = 20
  lim.attack.value = 0.001
  lim.release.value = 0.09
  const clip = ctx.createWaveShaper()
  clip.curve = softClipCurve()
  clip.oversample = '2x'
  const output = ctx.createGain()
  output.gain.value = db(-2)
  input.connect(lim).connect(clip).connect(output)
  return { input, lim, output }
}

interface Bus {
  /** Where instances connect. */
  input: GainNode
  /** Game-driven ducking (separate from the level so they never fight). */
  duck: GainNode
  meter: AnalyserNode | null
  peak: number
  sum: number
  frames: number
}

export interface MixStats {
  /** Per category: loudest and mean short-window RMS seen, dBFS (dev meters). */
  rms: Partial<Record<MixCategory, { peak: number; mean: number }>>
  /** Sounds each budget let through and turned away (`frontier-budget.ts`). */
  budget: Record<string, { played: number; dropped: number }>
  reduction: Record<'limiter' | 'glue', { max: number; mean: number }>
}

export class FrontierMix {
  readonly ctx: AudioContext
  /** Feeds the speakers in place of PlayCanvas's own last node (silent: see `chain`). */
  readonly mute: GainNode
  private readonly buses = new Map<MixCategory, Bus>()
  private readonly out: AudioNode
  /** The gain-reduction meters: master limiter and weapons glue, dB (dev). */
  private readonly reducers: Record<'limiter' | 'glue', DynamicsCompressorNode>
  private readonly reduction = {
    limiter: { max: 0, sum: 0, frames: 0 },
    glue: { max: 0, sum: 0, frames: 0 },
  }
  private fight = 0
  private showdown = false as boolean
  private readonly frame: Float32Array<ArrayBuffer> | null
  private meterDue = 0

  constructor(ctx: AudioContext, meters = false) {
    this.ctx = ctx
    this.mute = ctx.createGain()
    this.mute.gain.value = 0
    const master = limiter(ctx)
    master.output.connect(ctx.destination)
    this.out = master.output
    const weapons = glue(ctx)
    weapons.connect(master.input)
    this.reducers = { limiter: master.lim, glue: weapons }
    this.frame = meters ? new Float32Array(1024) : null
    for (const [name, spec] of Object.entries(CATEGORIES) as [MixCategory, CategorySpec][]) {
      const input = ctx.createGain()
      input.gain.value = db(spec.level)
      let node: AudioNode = input
      for (const c of spec.carve) {
        const f = ctx.createBiquadFilter()
        f.type = c.type
        f.frequency.value = c.hz
        if (c.q !== undefined) {
          f.Q.value = c.q
        }
        if (c.gain !== undefined) {
          f.gain.value = c.gain
        }
        node.connect(f)
        node = f
      }
      const duck = ctx.createGain()
      node.connect(duck)
      duck.connect(spec.into === 'weapons' ? weapons : master.input)
      let meter: AnalyserNode | null = null
      if (meters) {
        meter = ctx.createAnalyser()
        meter.fftSize = 1024
        duck.connect(meter)
      }
      this.buses.set(name, { input, duck, meter, peak: -120, sum: 0, frames: 0 })
    }
  }

  /** The node a category's sounds connect to. */
  input(category: MixCategory): GainNode {
    return (this.buses.get(category) as Bus).input
  }

  /** A category's processed output, for recording it as a stem (dev tools). */
  stem(category: MixCategory): AudioNode {
    return (this.buses.get(category) as Bus).duck
  }

  /** Your own shot: the other riders' reports, the tails and the town step back for a moment. */
  ownShot(): void {
    const t = this.ctx.currentTime
    for (const [name, dip] of Object.entries(OWN_SHOT) as [MixCategory, Dip][]) {
      const g = (this.buses.get(name) as Bus).duck.gain
      g.cancelScheduledValues(t)
      g.setTargetAtTime(this.rest(name) * db(dip.depth), t, 0.004)
      g.setTargetAtTime(this.rest(name), t + 0.03, dip.release / 3)
    }
  }

  /** How much gunfire has just reached the ear (0 quiet … 1 a full close volley). */
  setFight(load: number): void {
    const next = Math.min(1, Math.max(0, load))
    if (Math.abs(next - this.fight) < 0.02) {
      return
    }
    const rising = next > this.fight
    this.fight = next
    for (const name of Object.keys(FIGHT) as MixCategory[]) {
      ;(this.buses.get(name) as Bus).duck.gain.setTargetAtTime(
        this.rest(name),
        this.ctx.currentTime,
        rising ? 0.05 : FIGHT_RELEASE / 3,
      )
    }
  }

  setShowdown(on: boolean): void {
    if (this.showdown === on) {
      return
    }
    this.showdown = on
    for (const name of Object.keys(SHOWDOWN) as MixCategory[]) {
      ;(this.buses.get(name) as Bus).duck.gain.setTargetAtTime(
        this.rest(name),
        this.ctx.currentTime,
        0.4,
      )
    }
  }

  /** A category's duck level with nothing transient on it. */
  private rest(name: MixCategory): number {
    const showdown = this.showdown ? (SHOWDOWN[name] ?? 0) : 0
    return db(showdown + (FIGHT[name] ?? 0) * this.fight)
  }

  /** Dev meters: short-window RMS per category, sampled a few times a second. */
  meter(clock: number): void {
    const frame = this.frame
    if (!frame || clock < this.meterDue) {
      return
    }
    this.meterDue = clock + 0.1
    // Chrome's compressors report a phantom ~18 dB reduction on silence for their first second.
    for (const key of clock < 2 ? [] : (['limiter', 'glue'] as const)) {
      const r = -this.reducers[key].reduction
      this.reduction[key].max = Math.max(this.reduction[key].max, r)
      this.reduction[key].sum += r
      this.reduction[key].frames++
    }
    for (const bus of this.buses.values()) {
      if (!bus.meter) {
        continue
      }
      bus.meter.getFloatTimeDomainData(frame)
      let sum = 0
      for (const v of frame) {
        sum += v * v
      }
      const rms = 10 * Math.log10(sum / frame.length + 1e-12)
      if (rms > -90) {
        bus.peak = Math.max(bus.peak, rms)
        bus.sum += rms
        bus.frames++
      }
    }
  }

  /** Gain reduction seen on the master limiter and the weapons glue: worst and mean, dB. */
  reductionStats(): MixStats['reduction'] {
    const r = this.reduction
    const round = (v: number) => Math.round(v * 10) / 10
    const of = (k: 'limiter' | 'glue') => ({
      max: round(r[k].max),
      mean: round(r[k].sum / Math.max(1, r[k].frames)),
    })
    return { limiter: of('limiter'), glue: of('glue') }
  }

  stats(): MixStats['rms'] {
    const out: MixStats['rms'] = {}
    for (const [name, bus] of this.buses) {
      if (bus.frames > 0) {
        out[name] = {
          peak: Math.round(bus.peak * 10) / 10,
          mean: Math.round((bus.sum / bus.frames) * 10) / 10,
        }
      }
    }
    return out
  }

  dispose(): void {
    for (const bus of this.buses.values()) {
      bus.input.disconnect()
      bus.duck.disconnect()
      bus.meter?.disconnect()
    }
    this.out.disconnect()
    this.mute.disconnect()
  }
}
