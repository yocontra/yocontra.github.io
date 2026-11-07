import { type Matrix4, Quaternion, Vector3 } from 'three'
import type { VatBake } from './vat.ts'
import type { VatClipInfo } from './vat-shared.ts'

const hp0 = new Vector3()
const hp1 = new Vector3()
const hq0 = new Quaternion()
const hq1 = new Quaternion()

/** Head pose (root space) at a fractional frame of a clip. */
export function headAt(
  bake: VatBake,
  clip: VatClipInfo,
  frame: number,
  out: { position: Vector3; rotation: Quaternion },
): void {
  const f0 = Math.floor(frame)
  const f1 = (f0 + 1) % clip.frames
  const t = frame - f0
  const h = bake.head
  const o0 = (clip.start + f0) * 7
  const o1 = (clip.start + f1) * 7
  hp0.fromArray(h, o0)
  hp1.fromArray(h, o1)
  hq0.fromArray(h, o0 + 3)
  hq1.fromArray(h, o1 + 3)
  out.position.lerpVectors(hp0, hp1, t)
  out.rotation.slerpQuaternions(hq0, hq1, t)
}

/** Interpolated attachment transform, sampled on the body's exact animation clock. */
export function socketAt(
  track: Float32Array | undefined,
  clip: VatClipInfo,
  frame: number,
  out: Matrix4,
): boolean {
  if (!track) {
    return false
  }
  const f0 = Math.floor(frame)
  const f1 = (f0 + 1) % clip.frames
  const t = frame - f0
  const a = (clip.start + f0) * 10
  const b = (clip.start + f1) * 10
  hp0.fromArray(track, a)
  hp1.fromArray(track, b)
  hq0.fromArray(track, a + 3)
  hq1.fromArray(track, b + 3)
  socketScale0.fromArray(track, a + 7)
  socketScale1.fromArray(track, b + 7)
  socketPosition.lerpVectors(hp0, hp1, t)
  socketRotation.slerpQuaternions(hq0, hq1, t)
  socketScale.lerpVectors(socketScale0, socketScale1, t)
  out.compose(socketPosition, socketRotation, socketScale)
  return true
}
const socketPosition = new Vector3()
const socketRotation = new Quaternion()
const socketScale0 = new Vector3()
const socketScale1 = new Vector3()
const socketScale = new Vector3()
