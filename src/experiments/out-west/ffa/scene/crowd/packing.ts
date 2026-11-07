/** Two-byte octahedral normals; positions retain the same half-float precision in packed XYZ. */
import type { Vector3 } from 'three'

const sign = (value: number) => (value < 0 ? -1 : 1)
export function packNormal(normal: Vector3, out: Uint8Array, offset: number): void {
  const inv = 1 / (Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z) || 1)
  let x = normal.x * inv
  let y = normal.y * inv
  if (normal.z < 0) {
    const oldX = x
    x = (1 - Math.abs(y)) * sign(x)
    y = (1 - Math.abs(oldX)) * sign(y)
  }
  out[offset] = Math.round((x * 0.5 + 0.5) * 255)
  out[offset + 1] = Math.round((y * 0.5 + 0.5) * 255)
}
export function unpackNormal(encodedX: number, encodedY: number, out: Vector3): Vector3 {
  let x = (encodedX / 255) * 2 - 1
  let y = (encodedY / 255) * 2 - 1
  const z = 1 - Math.abs(x) - Math.abs(y)
  if (z < 0) {
    const oldX = x
    x = (1 - Math.abs(y)) * sign(x)
    y = (1 - Math.abs(oldX)) * sign(y)
  }
  return out.set(x, y, z).normalize()
}

export function atlasRows(
  vertices: number,
  frames: number,
  channels: number,
  width: number,
): number {
  return Math.ceil((vertices * frames * channels) / (width * 4))
}
