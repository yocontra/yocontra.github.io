import type { MoveState } from '../ffa/sim/types.ts'
/** Shared authoritative input contract; positions and rewards never come from clients. */
export const PROTOCOL_VERSION = 2
export const SIMULATION_HZ = 20
export const PHYSICS_HZ = 60
export const INPUT_SEND_HZ = 10
export const MAX_PLAYERS = 32
export const Buttons = {
  fire: 1,
  aim: 2,
  roll: 4,
  reload: 8,
  interact: 16,
  callout: 32,
  leave: 64,
  throw: 128,
  jump: 256,
  sprint: 512,
  crouch: 1024,
} as const
export interface PlayerInput {
  seq: number
  moveX: number
  moveZ: number
  yaw: number
  pitch: number
  buttons: number
}
export interface PlayerState {
  motion?: MoveState
  /** Button state at this pose, restored together with authority before input replay. */
  lastButtons?: number

  id: string
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  grounded: boolean
  /** Effective native capsule stance, including blocked stand-up and committed traversal. */
  crouched?: boolean
  hp: number
  ammo: number
  seq: number
}
export interface CollisionData {
  version: string
  boxes: readonly {
    center: readonly [number, number, number]
    halfExtents: readonly [number, number, number]
    rotation?: readonly [number, number, number]
  }[]
  meshes: readonly { positions: readonly number[]; indices: readonly number[] }[]
}
export const neutralInput = (): PlayerInput => ({
  seq: 0,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
})
export function validInput(input: unknown): input is PlayerInput {
  if (!input || typeof input !== 'object') {
    return false
  }
  const value = input as Partial<PlayerInput>
  return (
    Number.isSafeInteger(value.seq) &&
    (value.seq ?? -1) >= 0 &&
    Number.isFinite(value.moveX) &&
    Math.abs(value.moveX ?? 2) <= 1 &&
    Number.isFinite(value.moveZ) &&
    Math.abs(value.moveZ ?? 2) <= 1 &&
    Number.isFinite(value.yaw) &&
    Number.isFinite(value.pitch) &&
    Math.abs(value.pitch ?? 2) <= Math.PI / 2 &&
    Number.isInteger(value.buttons) &&
    (value.buttons ?? -1) >= 0 &&
    (value.buttons ?? 2048) <= 2047
  )
}
