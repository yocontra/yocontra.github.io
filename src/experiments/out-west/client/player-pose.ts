import { eyeHeight } from '../ffa/sim/combat.ts'
import { BODY_HEIGHT } from '../ffa/sim/constants.ts'
import { makeMoveState } from '../ffa/sim/types.ts'
import type { PlayerInput, PlayerState } from '../runtime/protocol.ts'
import type { PlayerRecord } from '../runtime/schema.ts'

/** Native poses store a standing-centre reference even while their capsule is shortened. */
export function poseEye(pose: PlayerState): { x: number; y: number; z: number } {
  return {
    x: pose.x,
    y: pose.y - BODY_HEIGHT / 2 + eyeHeight({ crouched: pose.crouched ?? false }),
    z: pose.z,
  }
}

/** Prediction uses the same movement gate as authority; judged showdown input stays separate. */
export function predictionInput<T extends PlayerInput>(
  input: T,
  rider: { alive: boolean; showdown: number; lingerUntil: number },
): T {
  return rider.alive && rider.showdown < 0 && rider.lingerUntil < 0
    ? input
    : { ...input, moveX: 0, moveZ: 0, buttons: 0 }
}

/** Presentation reads this client's intent and predicted motor, never a delayed server echo. */
export function ownPresentation(body: PlayerState, intent: PlayerInput): PlayerState {
  const motion = body.motion
  const committed =
    (motion?.rollTicks ?? 0) > 0 ||
    (motion?.slideTicks ?? 0) > 0 ||
    (motion?.climbTicks ?? 0) > 0 ||
    ((motion?.jumpTicks ?? 0) > 0 && (motion?.vaultStep ?? 0) > 0)
  const stopped = body.grounded && !committed && Math.hypot(intent.moveX, intent.moveZ) < 16 / 127
  return {
    ...body,
    yaw: intent.yaw,
    pitch: intent.pitch,
    vx: stopped ? 0 : body.vx,
    vz: stopped ? 0 : body.vz,
  }
}

interface SnapshotPose {
  id: string
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  grounded: boolean
  crouched?: boolean
  hp: number
  ammo: number
  seq: number
}
/** SDK interpolation supplies positions once; local animation uses the same native predicted motor. */
export function snapshotPresentation(
  record: SnapshotPose,
  position: { x: number; y: number; z: number },
  options: { predicted: PlayerState | undefined; intent: PlayerInput | undefined; yaw: number },
): PlayerState {
  const { predicted, intent, yaw } = options
  const pose: PlayerState = {
    ...position,
    id: record.id,
    vx: predicted?.vx ?? record.vx,
    vy: predicted?.vy ?? record.vy,
    vz: predicted?.vz ?? record.vz,
    yaw,
    pitch: ((record.pitch / 127) * Math.PI) / 2,
    grounded: predicted?.grounded ?? record.grounded,
    crouched: predicted?.crouched ?? record.crouched ?? false,
    hp: record.hp,
    ammo: record.ammo,
    seq: predicted?.seq ?? record.seq,
    ...(predicted?.motion ? { motion: predicted.motion } : {}),
  }
  return intent ? ownPresentation(pose, intent) : pose
}

interface RenderedSample {
  x: number
  y: number
  z: number
  at: number
  spawnTick: number
}
/** Animation follows exactly the SDK-displayed motion; this never filters or changes positions. */
export class RenderedVelocity {
  private readonly previous = new Map<string, RenderedSample>()
  reset(id: string): void {
    this.previous.delete(id)
  }
  sample(pose: PlayerState, spawnTick: number, at: number): PlayerState {
    const before = this.previous.get(pose.id)
    this.previous.set(pose.id, { x: pose.x, y: pose.y, z: pose.z, at, spawnTick })
    if (!before || before.spawnTick !== spawnTick) {
      return pose
    }
    const dt = (at - before.at) / 1000
    const distance = Math.hypot(pose.x - before.x, pose.y - before.y, pose.z - before.z)
    if (dt <= 0 || dt > 0.25 || distance > 2) {
      return pose
    }
    const vy = (pose.y - before.y) / dt
    return {
      ...pose,
      vx: (pose.x - before.x) / dt,
      vy,
      vz: (pose.z - before.z) / dt,
      grounded: pose.grounded && Math.abs(vy) < 0.35,
    }
  }
  retain(ids: ReadonlyMap<string, PlayerState>): void {
    for (const id of this.previous.keys()) {
      if (!ids.has(id)) {
        this.previous.delete(id)
      }
    }
  }
}

/** Restore all native motor state from the same acknowledged server pose. */
export function authoritativePlayerState(record: PlayerRecord, previous: PlayerState): PlayerState {
  return {
    ...previous,
    x: record.x,
    y: record.y + BODY_HEIGHT / 2,
    z: record.z,
    vx: record.vx,
    vy: record.vy,
    vz: record.vz,
    yaw: record.yaw,
    pitch: ((record.pitch / 127) * Math.PI) / 2,
    seq: record.seq,
    grounded: record.grounded,
    crouched: record.crouched,
    hp: record.hp,
    ammo: record.ammo,
    lastButtons: record.lastButtons,
    motion: {
      ...makeMoveState(record.x, record.z),
      ...record.motion.toJSON(),
      x: record.x,
      y: record.y,
      z: record.z,
      vy: record.vy,
      grounded: record.grounded,
    },
  }
}
