/**
 * One-shot upper-body gestures a rider makes on top of his clips (procedural, cheap): the
 * dynamite throw (arm back, then over), stooping for a bag or a pickup, the call-out (an arm up and
 * pointing), the draw (the gun arm swinging up from the hip on a spawn or a new gun), and the nod
 * at the bank window. `Locomotion` ticks it and applies it in its bone layer.
 */
import type { Bone, Vector3 } from 'three'

export type GestureKind = 'throw' | 'pickup' | 'callout' | 'draw' | 'bank'

const LENGTH: Record<GestureKind, number> = {
  throw: 0.55,
  pickup: 0.6,
  callout: 1.1,
  draw: 0.35,
  bank: 0.5,
}

/** A 0→1→0 bump over [a, b] of u. */
const bump = (u: number, a: number, b: number): number =>
  u <= a || u >= b ? 0 : Math.sin(((u - a) / (b - a)) * Math.PI)

export interface GestureRig {
  /** Rotate a bone about a world axis (its parent's world matrix current). */
  turn: (b: Bone, axis: Vector3, angle: number) => void
  armR: Bone | undefined
  foreR: Bone | undefined
  chest: Bone | undefined
  torso: Bone | undefined
  /** His right (pitch axis) and the world up (yaw axis). */
  right: Vector3
  up: Vector3
}

export class Gestures {
  private kind: GestureKind | null = null
  private t = 0

  start(kind: GestureKind): void {
    this.kind = kind
    this.t = 0
  }

  get active(): boolean {
    return this.kind !== null
  }

  step(dt: number): void {
    if (!this.kind) {
      return
    }
    this.t += dt
    if (this.t >= LENGTH[this.kind]) {
      this.kind = null
    }
  }

  /** Bend his bones for this moment of the gesture (after the clips and the aim layer). */
  apply(g: GestureRig): void {
    const k = this.kind
    if (!k) {
      return
    }
    const u = this.t / LENGTH[k]
    const { turn, armR, foreR, chest, torso, right, up } = g
    if (k === 'throw' && armR && foreR) {
      // wind up, then over the top
      turn(armR, right, -1.5 * bump(u, 0, 0.45) + 1.1 * bump(u, 0.35, 1))
      turn(foreR, right, -0.9 * bump(u, 0, 0.5))
      if (chest) {
        turn(chest, up, 0.45 * bump(u, 0, 0.5) - 0.3 * bump(u, 0.4, 1))
      }
    } else if ((k === 'pickup' || k === 'bank') && torso && chest) {
      const deep = k === 'pickup' ? 0.75 : 0.3
      turn(torso, right, -deep * 0.5 * bump(u, 0, 1))
      turn(chest, right, -deep * 0.5 * bump(u, 0, 1))
    } else if (k === 'callout' && armR) {
      // the arm up and out at the rider he's calling
      turn(armR, right, 1.4 * Math.min(1, bump(u, 0, 1) * 1.6))
    } else if (k === 'draw' && armR) {
      // from the hip up to the hold
      const e = u * u * (3 - 2 * u)
      turn(armR, right, -1.1 * (1 - e))
    }
  }
}
