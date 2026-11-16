/** Independent native-matrix reference for authored paired-grip regressions. */
import { type Animation, type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Mat4, Quat, Vec3 } from 'playcanvas'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const root = 'tools/art/characters'
const find = (doc: Document, name: string) => {
  const clip = doc
    .getRoot()
    .listAnimations()
    .find((a) => a.getName() === name)
  if (!clip) {
    throw new Error(`Missing ${name}`)
  }
  return clip
}
function channels(clip: Animation) {
  return new Map(
    clip.listChannels().map((c) => [`${c.getTargetNode()?.getName()}.${c.getTargetPath()}`, c]),
  )
}
function times(clip: Animation): number[] {
  return [
    ...new Set(clip.listSamplers().flatMap((s) => Array.from(s.getInput()?.getArray() ?? []))),
  ].sort((a, b) => a - b)
}
function sample(clip: Animation, time: number) {
  return new Map(
    clip.listChannels().map((c) => {
      const sampler = c.getSampler()
      const input = sampler?.getInput()
      const output = sampler?.getOutput()
      if (!(sampler && input && output)) {
        throw new Error('Missing animation data')
      }
      let index = 0
      while (index + 1 < input.getCount() && input.getScalar(index + 1) <= time) {
        index++
      }
      const a = output.getElement(index, [] as number[])
      if (index + 1 < input.getCount() && sampler.getInterpolation() !== 'STEP') {
        const b = output.getElement(index + 1, [] as number[])
        const alpha =
          (time - input.getScalar(index)) / (input.getScalar(index + 1) - input.getScalar(index))
        if (c.getTargetPath() === 'rotation') {
          const sign = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0) < 0 ? -1 : 1
          const q = new Quat(
            ...(a.map((v, i) => v * (1 - alpha) + (b[i] ?? 0) * sign * alpha) as [
              number,
              number,
              number,
              number,
            ]),
          ).normalize()
          return [`${c.getTargetNode()?.getName()}.${c.getTargetPath()}`, [q.x, q.y, q.z, q.w]]
        }
        return [
          `${c.getTargetNode()?.getName()}.${c.getTargetPath()}`,
          a.map((v, i) => v + ((b[i] ?? 0) - v) * alpha),
        ]
      }
      return [`${c.getTargetNode()?.getName()}.${c.getTargetPath()}`, a]
    }),
  )
}
function local(p: number[], q: number[], s: number[]) {
  return new Mat4().setTRS(
    new Vec3(p[0], p[1], p[2]),
    new Quat(q[0], q[1], q[2], q[3]).normalize(),
    new Vec3(s[0], s[1], s[2]),
  )
}
function world(skeleton: Document, clip: Animation, time: number, bone: string): Mat4 {
  const values = sample(clip, time)
  const node = skeleton
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === bone)
  if (!node) {
    throw new Error(`Missing ${bone}`)
  }
  const chain: (typeof node)[] = []
  for (let n: typeof node | null = node; n; n = n.getParentNode()) {
    chain.unshift(n)
  }
  const result = new Mat4()
  for (const n of chain) {
    result.mul(
      local(
        values.get(`${n.getName()}.translation`) ?? n.getTranslation(),
        values.get(`${n.getName()}.rotation`) ?? n.getRotation(),
        values.get(`${n.getName()}.scale`) ?? n.getScale(),
      ),
    )
  }
  return result
}
function frame(rows: number[][]) {
  return new Mat4().set(Array.from({ length: 16 }, (_, i) => rows[i % 4]?.[Math.floor(i / 4)] ?? 0))
}
interface Spin {
  pivotEndTime: number
  pivots: Record<string, number[]>
}
function sourceMount(
  mount: Mat4,
  seat: number[][],
  spin: Spin,
  { side, time }: { side: string; time: number },
): Mat4 {
  if (time > spin.pivotEndTime) {
    return mount
  }
  const values = spin.pivots[side]
  if (!values) {
    throw new Error('Missing spin pivot')
  }
  const pivot = new Vec3(values[0], values[1], values[2])
  const child = frame(seat)
  const relative = child.clone().invert().mul(mount).mul(child)
  const translation = pivot.clone().sub(relative.transformVector(pivot))
  relative.data[12] = translation.x
  relative.data[13] = translation.y
  relative.data[14] = translation.z
  return child.clone().mul(relative).mul(child.clone().invert())
}

export { channels, find, frame, io, local, root, type Spin, sample, sourceMount, times, world }
