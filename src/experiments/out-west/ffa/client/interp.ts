// biome-ignore-all lint/style/noExcessiveClassesPerFile: the remote track and the server clock are the two halves of interpolation
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `init` flips on the first observation; Biome narrows it to its initialiser
/**
 * Other players: rendered in the past between buffered snapshots, at a delay of two ticks (100 ms)
 * plus the recent worst snapshot lateness (`ServerClock.delay`), with up to 100 ms of
 * extrapolation when a snapshot is later still. Positions are metres, aim is radians.
 */
import { ANGLE_SCALE, ANIM_MASK, EF_ALIVE, POS_SCALE } from '../../contract/town.ts'
import type { EntityView } from '../sim/codec.ts'

/** The interpolation delay with no jitter (ticks): far riders refresh every other tick. */
export const INTERP_TICKS = 2
/** The adaptive delay's ceiling (ticks): 300 ms. */
const MAX_INTERP_TICKS = 6
/** Per-snapshot decay of the remembered worst lateness: it halves in ~7 s of calm. */
const LATE_DECAY = 0.995
const MAX_EXTRAP_TICKS = 2
/** Ticks to ease an overshoot back onto the newest sample. */
const EXTRAP_RETURN_TICKS = 4
const HISTORY = 16
/** A jump this large between samples is a respawn or a teleport: no lerp. */
const TELEPORT_M = 3

interface Sample {
  t: number
  x: number
  z: number
  aim: number
  hp: number
  flags: number
  anim: number
  carry: number
}

/** What the scene draws for one remote player this frame. */
export interface RemoteView {
  id: number
  x: number
  z: number
  aim: number
  hp: number
  flags: number
  /** `ANIM_*` (the low nibble of the wire's anim byte). */
  anim: number
  /** `STANCE_*` bits (crouched, on the sights, sprinting). */
  stance: number
  carry: number
  /** Ground velocity (m/s), from the samples around the render time. */
  vx: number
  vz: number
  /** False while the renderer has no sample old enough yet. */
  ready: boolean
}

const turn = (u8: number): number => ((u8 << 8) / ANGLE_SCALE) * Math.PI * 2

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  d = ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI
  return a + d * t
}

export class RemoteTrack {
  readonly id: number
  private readonly samples: Sample[] = []
  readonly view: RemoteView

  constructor(id: number) {
    this.id = id
    this.view = {
      id,
      x: 0,
      z: 0,
      aim: 0,
      hp: 100,
      flags: 0,
      anim: 0,
      stance: 0,
      carry: 0,
      vx: 0,
      vz: 0,
      ready: false,
    }
  }

  get newestTick(): number {
    return this.samples.at(-1)?.t ?? -1
  }

  push(t: number, e: EntityView): void {
    const last = this.samples.at(-1)
    if (last && t <= last.t) {
      return
    }
    this.samples.push({
      t,
      x: e.x / POS_SCALE,
      z: e.z / POS_SCALE,
      aim: turn(e.aim),
      hp: e.hp,
      flags: e.flags,
      anim: e.anim,
      carry: e.carry,
    })
    if (this.samples.length > HISTORY) {
      this.samples.shift()
    }
  }

  /** Resolve the view at fractional tick `rt`. */
  sample(rt: number): RemoteView {
    const s = this.samples
    const v = this.view
    const first = s[0]
    const last = s.at(-1)
    if (!(first && last)) {
      return v
    }
    v.ready = true
    if (rt <= first.t) {
      this.assign(first, first, 0)
      return v
    }
    if (rt >= last.t) {
      this.extrapolate(s.at(-2) ?? last, last, rt)
      return v
    }
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1]
      const b = s[i]
      if (a && b && rt >= a.t) {
        const k = (rt - a.t) / Math.max(1e-6, b.t - a.t)
        if (dist(a, b) > TELEPORT_M) {
          this.assign(k < 0.5 ? a : b, k < 0.5 ? a : b, 0)
          v.vx = 0
          v.vz = 0
        } else {
          this.assign(a, b, k)
          const span = (b.t - a.t) / 20
          v.vx = (b.x - a.x) / span
          v.vz = (b.z - a.z) / span
        }
        return v
      }
    }
    return v
  }

  /**
   * Past the newest sample: carried on along its last step for up to 2 ticks, then eased back onto
   * the newest sample over the next 4 (a far rider who stopped sends nothing more, so holding the
   * overshoot would leave him ~0.5 m past where he really stands).
   */
  private extrapolate(prev: Sample, last: Sample, rt: number): void {
    const v = this.view
    const over = rt - last.t
    const span = Math.max(1, last.t - prev.t)
    const moving = (last.flags & EF_ALIVE) !== 0 && dist(prev, last) < TELEPORT_M
    this.assign(last, last, 0)
    const vx = moving ? (last.x - prev.x) / span : 0
    const vz = moving ? (last.z - prev.z) / span : 0
    let ahead = Math.min(over, MAX_EXTRAP_TICKS)
    if (over > MAX_EXTRAP_TICKS) {
      const back = Math.min(1, (over - MAX_EXTRAP_TICKS) / EXTRAP_RETURN_TICKS)
      ahead = MAX_EXTRAP_TICKS * (1 - back * back * (3 - 2 * back))
    }
    v.x += vx * ahead
    v.z += vz * ahead
    // Past the cap the drawn rider stands (his last two samples still say "running": report the
    // ground speed he is actually drawn at, or the crowd runs him in place).
    const still = over >= MAX_EXTRAP_TICKS
    v.vx = still ? 0 : vx * 20
    v.vz = still ? 0 : vz * 20
  }

  private assign(a: Sample, b: Sample, k: number): void {
    const v = this.view
    v.x = a.x + (b.x - a.x) * k
    v.z = a.z + (b.z - a.z) * k
    v.aim = lerpAngle(a.aim, b.aim, k)
    // Discrete state switches at the midpoint.
    const d = k < 0.5 ? a : b
    v.hp = d.hp
    v.flags = d.flags
    v.anim = d.anim & ANIM_MASK
    v.stance = d.anim & ~ANIM_MASK
    v.carry = d.carry
  }
}

function dist(a: Sample, b: Sample): number {
  return Math.hypot(b.x - a.x, b.z - a.z)
}

/**
 * Server time as seen by this client, in fractional ticks: the newest snapshot's tick advanced by
 * local wall time. Early arrivals pull the estimate forward fast; late ones (jitter) barely
 * move it, so the render clock stays smooth.
 */
export class ServerClock {
  private offset = 0
  private init = false
  /** Recent arrival lateness, in ticks (jitter). */
  jitter = 0
  /** The worst recent lateness (ticks): jumps up at once, eases down over seconds. */
  private late = 0
  /** Interpolation delay for remote riders (ticks): `INTERP_TICKS` plus the worst lateness. */
  delay = INTERP_TICKS

  observe(tick: number, nowMs: number): void {
    const sample = tick - nowMs / 50
    if (!this.init) {
      this.offset = sample
      this.init = true
      return
    }
    const d = sample - this.offset
    this.jitter += (Math.abs(d) - this.jitter) * 0.05
    if (Math.abs(d) <= 20) {
      this.late = Math.max(-d, this.late * LATE_DECAY)
      this.delay = Math.min(MAX_INTERP_TICKS, INTERP_TICKS + this.late * 1.25)
    }
    if (Math.abs(d) > 20) {
      // Way off (a stall or a reconnect): resync.
      this.offset = sample
    } else {
      this.offset += d * (d > 0 ? 0.25 : 0.02)
    }
  }

  get ready(): boolean {
    return this.init
  }

  /** Fractional server tick now. */
  now(nowMs: number): number {
    return nowMs / 50 + this.offset
  }
}
