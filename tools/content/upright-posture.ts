/**
 * The retargeted Universal Animation Library clips carry the head well in front of the
 * shoulders. Every human clip receives one constant pitch about the parent's lateral axis:
 * the neck straightens and the head partly counter-rotates so the gaze stays level.
 */
import type { Accessor, Document } from '@gltf-transform/core'

const PITCH: Record<string, number> = { Neck: -11, Head: 4 }

function multiply(a: number[], b: number[]): number[] {
  const [ax = 0, ay = 0, az = 0, aw = 1] = a
  const [bx = 0, by = 0, bz = 0, bw = 1] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function uprightPosture(doc: Document): void {
  const corrected = new Set<Accessor>()
  for (const animation of doc.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const degrees = PITCH[channel.getTargetNode()?.getName() ?? '']
      const output = channel.getSampler()?.getOutput()
      if (degrees === undefined || channel.getTargetPath() !== 'rotation' || !output) {
        continue
      }
      if (corrected.has(output)) {
        continue
      }
      corrected.add(output)
      const half = (degrees * Math.PI) / 360
      const pitch = [Math.sin(half), 0, 0, Math.cos(half)]
      const cubic = channel.getSampler()?.getInterpolation() === 'CUBICSPLINE'
      for (let i = 0; i < output.getCount(); i++) {
        // Cubic spline tangents (first and last of each triple) rotate linearly too.
        const value = output.getElement(i, [])
        const rotated = multiply(pitch, value)
        output.setElement(i, cubic && i % 3 !== 1 ? rotated : normalize(rotated))
      }
    }
  }
}

function normalize(q: number[]): number[] {
  const length = Math.hypot(...q) || 1
  return q.map((v) => v / length)
}
