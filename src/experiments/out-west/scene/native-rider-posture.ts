/** Keep the visible player’s head over their shoulders while retaining the authored gaze. */
import {
  AnimCurve,
  AnimData,
  AnimEvents,
  AnimSnapshot,
  AnimTrack,
  INTERPOLATION_LINEAR,
  Quat,
  Vec3,
} from 'playcanvas'

const READY =
  /^(?:Idle_Gun(?:_Pointing)?(?:_Pair)?|Draw(?:_Pair)?|Gun_Shoot(?:_Pair)?|Reload|(?:Hold|Shoot)_(?:rifle|shotgun))$/u
const WALK = /^(?:Idle|Idle_Character|Idle_Neutral|Walk|Stride_Walk_[0-7])$/u
const corrected = new WeakMap<AnimTrack, AnimTrack>()

const target = (path: AnimCurve['paths'][number], bone: string, property: string): boolean =>
  path.component === 'graph' &&
  path.entityPath.at(-1) === bone &&
  path.propertyPath.length === 1 &&
  path.propertyPath[0] === property

function settleHead(track: AnimTrack, degrees: number): AnimTrack {
  const head = (path: AnimCurve['paths'][number]) => target(path, 'Head', 'localPosition')
  const headIndex = track.curves.findIndex((curve) => curve.paths.some(head))
  const neckIndex = track.curves.findIndex((curve) =>
    curve.paths.some((path) => target(path, 'Neck', 'localRotation')),
  )
  const position = track.curves[headIndex]
  const rotation = track.curves[neckIndex]
  const positionTimes = position && track.inputs[position.input]
  const rotationTimes = rotation && track.inputs[rotation.input]
  if (!(position && positionTimes && rotationTimes)) {
    return track
  }

  const frames = [
    ...new Set([0, ...positionTimes.data, ...rotationTimes.data, track.duration]),
  ].sort((left, right) => left - right)
  const samples = new AnimSnapshot(track)
  const neck = new Quat()
  const inverse = new Quat()
  const local = new Vec3()
  const pitch = new Quat().setFromAxisAngle(Vec3.RIGHT, degrees)
  const values = new Float32Array(frames.length * 3)
  for (const [frame, time] of frames.entries()) {
    track.eval(time, samples)
    const [x = 0, y = 0, z = 0, w = 1] = samples._results[neckIndex] ?? []
    const [side = 0, height = 0, depth = 0] = samples._results[headIndex] ?? []
    neck.set(x, y, z, w).normalize()
    inverse.copy(neck).invert()
    // Rotate only the neck-to-head offset in chest space. The neck root,
    // skull rotation and all child sockets keep their authored transforms.
    neck.transformVector(local.set(side, height, depth), local)
    pitch.transformVector(local, local)
    inverse.transformVector(local, local)
    values.set([local.x, local.y, local.z], frame * 3)
  }

  const curves = [...track.curves]
  const otherPaths = position.paths.filter((path) => !head(path))
  if (otherPaths.length > 0) {
    curves[headIndex] = new AnimCurve(
      otherPaths,
      position.input,
      position.output,
      position.interpolation,
    )
  } else {
    curves.splice(headIndex, 1)
  }
  curves.push(
    new AnimCurve(
      position.paths.filter(head),
      track.inputs.length,
      track.outputs.length,
      INTERPOLATION_LINEAR,
    ),
  )
  return new AnimTrack(
    track.name,
    track.duration,
    [...track.inputs, new AnimData(1, Float32Array.from(frames))],
    [...track.outputs, new AnimData(3, values)],
    curves,
    new AnimEvents(Array.isArray(track.events) ? track.events : track.events.events),
  )
}

export function visibleRiderPosture(track: AnimTrack): AnimTrack {
  const ready = READY.test(track.name)
  if (!(ready || WALK.test(track.name))) {
    return track
  }
  const cached = corrected.get(track)
  if (cached) {
    return cached
  }
  const result = settleHead(track, ready ? -15 : -12)
  corrected.set(track, result)
  return result
}
