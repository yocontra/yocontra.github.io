/** Physical camera placement, independent of the local arms presentation. */
import { type Entity, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, Vec3 } from 'playcanvas'
import type { FrontierSettings } from '../ffa/client/settings.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import type { GameInput } from './input.ts'
import { poseEye } from './player-pose.ts'

const FOLLOW_DISTANCE = 4.5
const WALL_CLEARANCE = 0.18
const RELEASE_RATE = 9
const CORNERS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const
type Trace = (from: Vec3, to: Vec3) => Vec3 | null

interface CameraOptions {
  camera: Entity
  player: PlayerState
  input: Pick<GameInput, 'pitch' | 'yaw'>
  settings: FrontierSettings
  first: boolean
  recoil: number
  trace: Trace | undefined
  dt: number
  reducedMotion: boolean
}

export class FollowCamera {
  private readonly head = new Vec3()
  private readonly eye = new Vec3()
  private readonly target = new Vec3()
  private readonly lastHead = new Vec3()
  private readonly right = new Vec3()
  private readonly up = new Vec3()
  private readonly offset = new Vec3()
  private readonly start = new Vec3()
  private readonly end = new Vec3()
  private previousPlayer: string | undefined
  private extension = 1

  reset(): void {
    this.previousPlayer = undefined
    this.extension = 1
  }

  place(options: CameraOptions): void {
    const { camera, player, input, settings, first } = options
    const { x, y, z } = poseEye(player)
    this.head.set(x, y, z)
    const pitch = input.pitch + options.recoil
    const sin = Math.sin(pitch)
    const cos = Math.cos(pitch)
    const sy = Math.sin(input.yaw)
    const cy = Math.cos(input.yaw)
    this.target.set(x - sy * cos * 20, y + sin * 20, z - cy * cos * 20)

    const top = settings.view === 'top'
    if (top) {
      this.reset()
      this.eye.set(x, y + 30, z + 0.01)
      this.target.copy(this.head)
    } else if (first) {
      this.reset()
      this.eye.copy(this.head)
    } else {
      const shoulder = settings.shoulder * 0.6
      this.eye.set(
        x + sy * cos * FOLLOW_DISTANCE + cy * shoulder,
        y - sin * FOLLOW_DISTANCE + 0.5,
        z + cy * cos * FOLLOW_DISTANCE - sy * shoulder,
      )
      this.right.set(cy, 0, -sy)
      this.up.set(sy * sin, cos, cy * sin)
      this.follow(options)
    }

    camera.setPosition(this.eye)
    camera.lookAt(this.target)
    const lens = camera.camera
    if (lens) {
      lens.projection = top ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE
      lens.orthoHeight = 18
      lens.fov = first ? settings.fovFirst : settings.fovThird
    }
  }

  private follow({ camera, player, trace, settings, dt, reducedMotion }: CameraOptions): void {
    const allowed = trace ? this.clearance(trace, camera, settings.fovThird) : 1
    const fresh = this.previousPlayer !== player.id || this.lastHead.distance(this.head) > 2
    // Pull in immediately for solid cover. Ease the return so a door jamb cannot pop the frame.
    if (fresh || reducedMotion || allowed <= this.extension) {
      this.extension = allowed
    } else {
      const step = 1 - Math.exp(-Math.min(dt, 0.05) * RELEASE_RATE)
      this.extension += (allowed - this.extension) * step
      if (allowed - this.extension < 0.002) {
        this.extension = allowed
      }
    }
    this.lastHead.copy(this.head)
    this.previousPlayer = player.id
    this.eye.lerp(this.head, this.eye, this.extension)
  }

  private clearance(trace: Trace, camera: Entity, fov: number): number {
    const lens = camera.camera
    // Cover the near-plane corners even when the over-shoulder camera looks slightly inward.
    const halfHeight = (lens?.nearClip ?? 0.1) * Math.tan((fov * Math.PI) / 360) * 1.35
    const halfWidth = halfHeight * (lens?.aspectRatio ?? 1)
    let limit = rayLimit(trace, this.head, this.eye)
    for (const [side, height] of CORNERS) {
      this.offset
        .copy(this.right)
        .mulScalar(side * halfWidth)
        .addScaled(this.up, height * halfHeight)
      this.end.add2(this.eye, this.offset)
      this.start.copy(this.head).add(this.offset)
      limit = Math.min(limit, rayLimit(trace, this.start, this.end))
    }
    return limit
  }
}

function rayLimit(trace: Trace, from: Vec3, to: Vec3): number {
  const hit = trace(from, to)
  return hit ? Math.max(0, (from.distance(hit) - WALL_CLEARANCE) / from.distance(to)) : 1
}
