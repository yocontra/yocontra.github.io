/**
 * Every rider's feet, heard from their own emitter (it follows them, so a step never jumps): a
 * footfall on the surface under them at the cadence of their gait, a scuff and cloth on the jump,
 * a heavier step and cloth on the landing, and their spurs. Riders beyond the step range, standing,
 * or sliding make no footfalls; a wall or floor between you muffles them.
 */
import { BODY_HEIGHT, CROUCH_SPEED } from '../ffa/sim/constants.ts'
import { type StepSurface, stepSurface } from './audio-surfaces.ts'
import type { Emitter, FrontierAudio } from './frontier-audio.ts'
import { type FrontierSound, RANGES, STEP_SOUND, spurTimbre, stepRate } from './frontier-sounds.ts'

export interface RiderPose {
  x: number
  y: number
  z: number
  vx?: number
  vy: number
  vz?: number
  grounded: boolean
  crouched?: boolean
}

interface Feet {
  emitter: Emitter
  x: number
  y: number
  z: number
  /** Horizontal speed: the pose's own velocity, or smoothed from its positions when it has none. */
  speed: number
  next: number
  air: number
  grounded: boolean
  spurs: 'jingle' | 'rattle' | null
  seen: number
  /** Among the nearest few this frame (always, for your own feet). */
  voiced: boolean
}

/** Slower than this is standing still; crouched and faster than this is a slide (no footfalls). */
const STILL = 0.7
const SLIDING = CROUCH_SPEED + 0.8
/** A jump needs this much upward speed; a landing this long in the air. */
const JUMP_VY = 1
const LANDING_AIR = 0.22
/** A move this far in one frame is a respawn or a correction, not a stride. */
const TELEPORT = 4
const OCCLUDED = { hz: 800, gain: 0.5 }
/** Only the nearest few riders' feet are voiced (and always your own): steps stay discrete. */
const VOICES = 4

/** How loud a footfall is for a gait (your own sit lower than the riders you listen for). */
function stepLevel(speed: number, crouched: boolean, self: boolean): number {
  let level = 0.6
  if (crouched) {
    level = 0.38
  } else if (speed > 6.5) {
    level = 1
  } else if (speed > 4) {
    level = 0.85
  }
  return level * (self ? 0.55 : 1)
}

const surfaceOf = (f: Feet): StepSurface => stepSurface(f.x, f.y, f.z)
/** Poses carry the standing capsule's centre; the boots are half a body below it. */
const sole = (pose: RiderPose): number => pose.y - BODY_HEIGHT / 2

export class FrontierFeet {
  private readonly audio: FrontierAudio
  private readonly feet = new Map<string, Feet>()

  constructor(audio: FrontierAudio) {
    this.audio = audio
  }

  update(
    dt: number,
    riders: ReadonlyMap<string, RiderPose>,
    self: string,
    spursOf: (id: string) => string | undefined,
  ): void {
    const near: [string, number][] = []
    for (const [id, pose] of riders) {
      const f = this.feet.get(id) ?? this.add(id, pose, spursOf(id))
      this.track(f, pose, dt)
      const d = this.audio.distance(f)
      if (id !== self && d <= RANGES.step.cull) {
        near.push([id, d])
      }
    }
    near.sort((a, b) => a[1] - b[1])
    const voiced = new Set(near.slice(0, VOICES).map(([id]) => id))
    for (const [id, pose] of riders) {
      const f = this.feet.get(id)
      if (f) {
        f.voiced = id === self || voiced.has(id)
        this.step(f, pose, id === self, dt)
      }
    }
    for (const [id, f] of this.feet) {
      if (!riders.has(id) || this.audio.clock - f.seen > 2) {
        f.emitter.entity.destroy()
        this.feet.delete(id)
      }
    }
  }

  private add(id: string, pose: RiderPose, spurs: string | undefined): Feet {
    const f: Feet = {
      emitter: this.audio.emitter(`feet-${id}`),
      x: pose.x,
      y: sole(pose),
      z: pose.z,
      speed: 0,
      next: this.audio.clock + Math.random() * 0.3,
      air: 0,
      grounded: pose.grounded,
      spurs: spurTimbre(spurs),
      seen: this.audio.clock,
      voiced: false,
    }
    this.feet.set(id, f)
    return f
  }

  private track(f: Feet, pose: RiderPose, dt: number): void {
    f.seen = this.audio.clock
    const moved = Math.hypot(pose.x - f.x, pose.z - f.z)
    const own = Math.hypot(pose.vx ?? 0, pose.vz ?? 0)
    if (moved > TELEPORT) {
      f.speed = 0
    } else if (own > 0) {
      f.speed = own
    } else if (dt > 0) {
      f.speed += (moved / dt - f.speed) * Math.min(1, dt * 10)
    }
    f.x = pose.x
    f.y = sole(pose)
    f.z = pose.z
    f.emitter.entity.setPosition(pose.x, f.y + 0.05, pose.z)
  }

  private step(f: Feet, pose: RiderPose, self: boolean, dt: number): void {
    const clock = this.audio.clock
    const heard = f.voiced
    if (!pose.grounded) {
      if (f.grounded && pose.vy > JUMP_VY && heard) {
        this.sound(f, 'cloth', self ? 0.6 : 0.5, 1.05)
        this.sound(f, STEP_SOUND[surfaceOf(f)], self ? 0.45 : 0.4, 1.1)
      }
      f.air += dt
      f.grounded = false
      return
    }
    if (!f.grounded) {
      if (f.air > LANDING_AIR && heard) {
        const hard = Math.min(1, 0.55 + f.air * 0.6)
        this.sound(f, STEP_SOUND[surfaceOf(f)], hard, 0.86)
        this.sound(f, 'cloth', hard * 0.8, 0.9)
        f.next = clock + 0.3
      }
      f.grounded = true
      f.air = 0
    }
    if (f.speed < STILL || (pose.crouched && f.speed > SLIDING) || !heard) {
      f.next = Math.max(f.next, clock + 0.12)
      return
    }
    if (clock < f.next) {
      return
    }
    // a roll is quicker than any stride: hold it to the sprint's cadence
    f.next = clock + (1 / stepRate(Math.min(f.speed, 8))) * (0.94 + Math.random() * 0.12)
    const crouched = Boolean(pose.crouched)
    const volume = stepLevel(f.speed, crouched, self)
    this.sound(f, STEP_SOUND[surfaceOf(f)], volume, 0.94 + Math.random() * 0.12)
    if (f.spurs && !crouched) {
      const jingle = f.spurs === 'jingle'
      this.sound(f, 'spurs', volume * (jingle ? 0.9 : 0.6), jingle ? 1.08 : 0.92)
    }
  }

  private sound(f: Feet, name: FrontierSound, volume: number, pitch: number): void {
    this.audio.playOn(f.emitter, name, { range: 'step', volume, pitch, occlude: OCCLUDED })
  }

  destroy(): void {
    for (const f of this.feet.values()) {
      f.emitter.entity.destroy()
    }
    this.feet.clear()
  }
}
