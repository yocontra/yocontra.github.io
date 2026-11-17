/** Physical camera placement, independent of the local arms presentation. */
import { type Entity, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, Vec3 } from 'playcanvas'
import type { FrontierSettings } from '../ffa/client/settings.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import type { GameInput } from './input.ts'
import { poseEye } from './player-pose.ts'

const head = new Vec3()
const eye = new Vec3()
const target = new Vec3()
export function placeCamera(options: {
  camera: Entity
  player: PlayerState
  input: GameInput
  settings: FrontierSettings
  first: boolean
  recoil: number
  trace: ((from: Vec3, to: Vec3) => Vec3 | null) | undefined
}): void {
  const { camera, player, input, settings, first, trace } = options
  const point = poseEye(player)
  head.set(point.x, point.y, point.z)
  const pitch = input.pitch + options.recoil
  const cp = Math.cos(pitch)
  target.set(
    head.x - Math.sin(input.yaw) * cp * 20,
    head.y + Math.sin(pitch) * 20,
    head.z - Math.cos(input.yaw) * cp * 20,
  )
  if (first) {
    eye.copy(head)
  } else {
    eye.set(
      head.x + Math.sin(input.yaw) * cp * 4.5 + Math.cos(input.yaw) * settings.shoulder * 0.6,
      head.y - Math.sin(pitch) * 4.5 + 0.5,
      head.z + Math.cos(input.yaw) * cp * 4.5 - Math.sin(input.yaw) * settings.shoulder * 0.6,
    )
    const hit = trace?.(head, eye)
    if (hit) {
      eye.lerp(head, hit, 0.9)
    }
  }
  camera.setPosition(eye)
  camera.lookAt(target)
  if (settings.view === 'top') {
    camera.setPosition(head.x, head.y + 30, head.z + 0.01)
    camera.lookAt(head)
  }
  const lens = camera.camera
  if (lens) {
    lens.projection = settings.view === 'top' ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE
    lens.orthoHeight = 18
    lens.fov = first ? settings.fovFirst : settings.fovThird
  }
}
