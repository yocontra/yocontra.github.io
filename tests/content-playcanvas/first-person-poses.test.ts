import { expect, test as it } from 'bun:test'
import { type Animation, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
function channels(clip: Animation) {
  return new Map(
    clip.listChannels().map((channel) => [
      `${channel.getTargetNode()?.getName()}.${channel.getTargetPath()}`,
      {
        times: Array.from(channel.getSampler()?.getInput()?.getArray() ?? []),
        values: Array.from(channel.getSampler()?.getOutput()?.getArray() ?? []),
      },
    ]),
  )
}

it('first-person elbow poses preserve complete firing clocks and every finger, gun and body channel', async () => {
  const [source, poses] = await Promise.all([
    io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb'),
    io.read('tools/art/characters/first-person-poses.glb'),
  ])
  await validateAuthoringInputs(poses)
  const changed = new Set(
    ['UpperArmL', 'LowerArmL', 'WristL', 'UpperArmR', 'LowerArmR', 'WristR'].map(
      (bone) => `${bone}.rotation`,
    ),
  )
  const clips = poses.getRoot().listAnimations()
  expect(clips).toHaveLength(8)
  for (const clip of clips) {
    const original = source
      .getRoot()
      .listAnimations()
      .find((entry) => entry.getName() === clip.getName())
    if (!original) {
      throw new Error('Viewmodel clip has no canonical world pose')
    }
    const before = channels(original)
    const after = channels(clip)
    expect([...after.keys()]).toEqual([...before.keys()])
    const duration = (animation: Animation) =>
      Math.max(...animation.listSamplers().map((sampler) => sampler.getInput()?.getMax([])[0] ?? 0))
    expect(duration(clip)).toBe(duration(original))
    const untouched = [...after].filter(([name]) => !changed.has(name))
    expect(untouched.length).toBeGreaterThan(100)
    for (const [name, value] of untouched) {
      const originalChannel = before.get(name)
      if (!originalChannel) {
        throw new Error(`Missing original channel ${name}`)
      }
      expect(value).toEqual(originalChannel)
    }
  }
  const report = poses.getRoot().getExtras().report as {
    interpolatedWristErrorMeters: number
    interpolatedWristAngleDegrees: number
  }[]
  expect(report).toHaveLength(8)
  for (const row of report) {
    expect(row.interpolatedWristErrorMeters).toBeLessThan(0.0005)
    expect(row.interpolatedWristAngleDegrees).toBeLessThan(0.1)
  }
})
