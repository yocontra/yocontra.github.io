/** Viewmodel sway, bob, sprint, landing and recoil springs stepped by the existing viewport update. */
import { math, Quat, Vec3 } from 'playcanvas'
import type { Player } from '../ffa/sim/types.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import type { HeldWeapon } from './first-person-sights.ts'

interface Spring {
  value: number
  velocity: number
  step: (target: number, dt: number) => number
  reset: () => void
}
/** Damped spring integrated at a fixed 120 Hz substep so low frame rates stay stable. */
function spring(stiffness: number, damping: number): Spring {
  const state: Spring = {
    value: 0,
    velocity: 0,
    step(target, dt) {
      const steps = Math.ceil(dt / (1 / 120))
      const h = dt / Math.max(1, steps)
      for (let i = 0; i < steps; i++) {
        state.velocity += (-stiffness * (state.value - target) - damping * state.velocity) * h
        state.value += state.velocity * h
      }
      return state.value
    },
    reset() {
      state.value = 0
      state.velocity = 0
    },
  }
  return state
}

const KICK: Record<HeldWeapon, { back: number; pitch: number; roll: number }> = {
  revolver: { back: 0.045, pitch: 7, roll: 2 },
  rifle: { back: 0.06, pitch: 4, roll: 1.5 },
  shotgun: { back: 0.09, pitch: 7.5, roll: 3 },
}
const PIVOT = new Vec3(0.05, -0.12, -0.35)
const motion = new Quat()
const pivoted = new Vec3()

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

export interface MotionFrame {
  player: PlayerState
  domain: Player | undefined
  held: HeldWeapon
  sight: number
  dt: number
}

export class ViewmodelMotion {
  private lastYaw: number | undefined
  private lastPitch = 0
  private bobPhase = 0
  private grounded = true
  private readonly bob = spring(60, 15)
  private readonly sprint = spring(90, 19)
  private readonly swayYaw = spring(140, 20)
  private readonly swayPitch = spring(140, 20)
  private readonly lift = spring(120, 14)
  private readonly kickBack = spring(260, 24)
  private readonly kickPitch = spring(220, 22)
  private readonly kickRoll = spring(180, 20)
  /** A new life starts without leftover recoil or landing motion. */
  reset(): void {
    this.lastYaw = undefined
    this.lastPitch = 0
    this.bobPhase = 0
    this.grounded = true
    for (const settled of [
      this.bob,
      this.sprint,
      this.swayYaw,
      this.swayPitch,
      this.lift,
      this.kickBack,
      this.kickPitch,
      this.kickRoll,
    ]) {
      settled.reset()
    }
  }
  kick(held: HeldWeapon): void {
    const kick = KICK[held]
    this.kickBack.velocity += kick.back * 22
    this.kickPitch.velocity += kick.pitch * 22
    this.kickRoll.velocity += kick.roll * (Math.random() < 0.5 ? -22 : 22)
  }
  /** Offsets a camera-space arms placement; aiming steadies sway, bob and part of the kick. */
  apply(frame: MotionFrame, position: Vec3, rotation: Quat): void {
    const { player, domain, held, sight, dt } = frame
    const turn =
      this.lastYaw === undefined ? 0 : math.clamp(wrap(player.yaw - this.lastYaw) / dt, -12, 12)
    const nod =
      this.lastYaw === undefined ? 0 : math.clamp((player.pitch - this.lastPitch) / dt, -12, 12)
    this.lastYaw = player.yaw
    this.lastPitch = player.pitch
    const steady = 1 - 0.8 * sight
    const swayYaw = this.swayYaw.step(math.clamp(-turn * 0.018, -0.07, 0.07) * steady, dt)
    const swayPitch = this.swayPitch.step(math.clamp(-nod * 0.018, -0.05, 0.05) * steady, dt)
    const speed = Math.hypot(player.vx, player.vz)
    const moving = player.grounded ? math.clamp(speed / 5.66, 0, 1) : 0
    this.bobPhase = (this.bobPhase + dt * (5 + speed * 1.15)) % (Math.PI * 4)
    const bob = this.bob.step(moving, dt) * (1 - 0.85 * sight)
    const sprint = this.sprint.step(domain?.sprinting && sight === 0 ? 1 : 0, dt)
    if (player.grounded && !this.grounded) {
      this.lift.velocity -= math.clamp(Math.abs(player.vy) * 0.05, 0.1, 0.5)
    }
    this.grounded = player.grounded
    const lift = this.lift.step(
      player.grounded ? 0 : math.clamp(-player.vy * 0.004, -0.025, 0.025),
      dt,
    )
    const back = this.kickBack.step(0, dt)
    const kickPitch = this.kickPitch.step(0, dt)
    const kickRoll = this.kickRoll.step(0, dt)
    const recoil = 1 - 0.35 * sight
    motion.setFromEulerAngles(
      (swayPitch + Math.cos(this.bobPhase) * 0.012 * bob) * math.RAD_TO_DEG +
        kickPitch * recoil -
        sprint * 16,
      swayYaw * math.RAD_TO_DEG + sprint * 12,
      kickRoll * recoil + Math.sin(this.bobPhase * 0.5) * 1.2 * bob + sprint * 14,
    )
    pivoted.sub2(position, PIVOT)
    motion.transformVector(pivoted, pivoted)
    position.add2(PIVOT, pivoted)
    rotation.mul2(motion, rotation)
    const lowered = held === 'revolver' ? 0.03 : 0.05
    position.x += Math.sin(this.bobPhase * 0.5) * 0.012 * bob + sprint * 0.02
    position.y += -Math.abs(Math.cos(this.bobPhase * 0.5)) * 0.01 * bob + lift - sprint * lowered
    position.z += back * recoil
  }
}
