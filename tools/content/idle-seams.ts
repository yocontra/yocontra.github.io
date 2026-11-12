/**
 * The authored idle loops end in a different pose than they start: Idle_Drunk's torso steps
 * 12° across the wrap, the legs up to 7.6° and the left arm and head up to 6°. The opening and
 * closing seconds of each looping channel ease onto a shared midpoint, so the sway stays
 * authored and the keys and timing are unchanged.
 */
import type { Accessor, AnimationChannel, Document } from '@gltf-transform/core'

const LOOPS = new Set(['Idle_Character', 'Idle_Drunk', 'Idle_Shaky'])
const WINDOW = 1.5
const TOLERANCE = Math.PI / 180

type Quat = [number, number, number, number]

function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

const conjugate = ([x, y, z, w]: Quat): Quat => [-x, -y, -z, w]
const dot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
const angle = (a: Quat, b: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b))))

function normalize(q: Quat): Quat {
  const length = Math.hypot(...q) || 1
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}

/** Fraction `s` of rotation `q` (shortest arc). */
function partial(q: Quat, s: number): Quat {
  const shortest: Quat = q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q
  const theta = Math.acos(Math.min(1, shortest[3]))
  const sine = Math.sin(theta)
  if (sine < 1e-6) {
    return [0, 0, 0, 1]
  }
  const k = Math.sin(s * theta) / sine
  return [shortest[0] * k, shortest[1] * k, shortest[2] * k, Math.cos(s * theta)]
}

const ease = (t: number): number => t * t * (3 - 2 * t)

function loopChannel(channel: AnimationChannel): { input: Accessor; output: Accessor } | null {
  const sampler = channel.getSampler()
  const input = sampler?.getInput()
  const output = sampler?.getOutput()
  if (
    channel.getTargetPath() !== 'rotation' ||
    sampler?.getInterpolation() !== 'LINEAR' ||
    !(input && output) ||
    output.getCount() < 4
  ) {
    return null
  }
  return { input, output }
}

function closeSeam(input: Accessor, output: Accessor): void {
  const last = output.getCount() - 1
  const key = (i: number): Quat => output.getElement(i, [0, 0, 0, 1]) as Quat
  const end = key(last)
  // Repaired channels duplicate the final key at t=0; their opening motion starts at key 1.
  const repaired = key(0).every((value, i) => value === end[i])
  const first = repaired ? 1 : 0
  let start = repaired ? normalize(multiply(multiply(key(1), conjugate(key(2))), key(1))) : key(0)
  if (angle(start, normalize(end)) < TOLERANCE) {
    return
  }
  if (dot(start, end) < 0) {
    start = [-start[0], -start[1], -start[2], -start[3]]
  }
  // Both sides meet halfway: the opening eases out of the midpoint, the close eases into it.
  const correction = multiply(start, conjugate(end))
  const undo = conjugate(correction)
  const duration = input.getScalar(last)
  for (let i = first; i <= last; i++) {
    const time = input.getScalar(i)
    const opening = 1 - time / WINDOW
    const closing = Math.min(1, (time - (duration - WINDOW)) / WINDOW)
    if (opening > 0) {
      output.setElement(i, normalize(multiply(partial(undo, 0.5 * ease(opening)), key(i))))
    } else if (closing > 0) {
      output.setElement(i, normalize(multiply(partial(correction, 0.5 * ease(closing)), key(i))))
    }
  }
  if (repaired) {
    output.setElement(0, output.getElement(last, []))
  }
}

export function closeIdleSeams(doc: Document): void {
  const animations = doc.getRoot().listAnimations()
  // Outputs shared with non-looping clips keep their authored keys.
  const closed = new Set<Accessor>(
    animations
      .filter((animation) => !LOOPS.has(animation.getName()))
      .flatMap((animation) =>
        animation.listSamplers().flatMap((sampler) => sampler.getOutput() ?? []),
      ),
  )
  for (const animation of animations) {
    if (!LOOPS.has(animation.getName())) {
      continue
    }
    for (const channel of animation.listChannels()) {
      const loop = loopChannel(channel)
      if (loop && !closed.has(loop.output)) {
        closed.add(loop.output)
        closeSeam(loop.input, loop.output)
      }
    }
  }
}
