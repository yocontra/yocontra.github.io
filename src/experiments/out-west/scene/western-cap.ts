/** Curved set-in cap frames turn from the torso aperture into the actual hanging arm. */
import { Quaternion, type Vector3 } from 'three'

export interface SleeveRow {
  center: Vector3
  direction: Vector3
  cap: number | undefined
  radius: number
}
export function sleevePath(
  start: Vector3,
  outward: Vector3,
  arm: { shoulder: Vector3; elbow: Vector3; wrist: Vector3 },
): SleeveRow[] {
  const axis = arm.elbow.clone().sub(arm.shoulder).normalize()
  const end = arm.shoulder.clone().lerp(arm.elbow, 0.45)
  const handle = Math.min(0.055, arm.shoulder.distanceTo(arm.elbow) * 0.22)
  const a = start.clone().addScaledVector(outward, handle)
  const b = end.clone().addScaledVector(axis, -handle)
  const turn = new Quaternion().setFromUnitVectors(outward, axis)
  const rows: SleeveRow[] = []
  for (let step = 1; step <= 10; step++) {
    const t = step / 10
    const u = 1 - t
    rows.push({
      center: start
        .clone()
        .multiplyScalar(u ** 3)
        .addScaledVector(a, 3 * u * u * t)
        .addScaledVector(b, 3 * u * t * t)
        .addScaledVector(end, t ** 3),
      direction: outward.clone().applyQuaternion(new Quaternion().slerp(turn, t)),
      cap: t,
      radius: 0.062,
    })
  }
  for (const along of [0.62, 0.8, 1]) {
    rows.push({
      center: arm.shoulder.clone().lerp(arm.elbow, along),
      direction: axis,
      cap: undefined,
      radius: 0.062,
    })
  }
  const forearm = arm.wrist.clone().sub(arm.elbow).normalize()
  for (const along of [0.33, 0.66, 0.94]) {
    rows.push({
      center: arm.elbow.clone().lerp(arm.wrist, along),
      direction: forearm,
      cap: undefined,
      radius: 0.062 - 0.017 * along,
    })
  }
  return rows
}
