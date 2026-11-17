import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  DYNAMITE_RELEASE_SECONDS,
  DYNAMITE_THROW_SECONDS,
} from '../../src/experiments/out-west/scene/native-animation-timing.ts'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
it('the authored toss returns to ready, plants the feet and binds the visual release to native time', async () => {
  const doc = await io.read('tools/art/characters/gestures/dynamite.glb')
  await validateAuthoringInputs(doc)
  expect(doc.getRoot().getExtras().durationSeconds).toBe(DYNAMITE_THROW_SECONDS)
  expect(doc.getRoot().getExtras().releaseSeconds).toBe(DYNAMITE_RELEASE_SECONDS)
  expect(doc.getRoot().getExtras().maximumFootMotionMeters).toBe(0)
  const clip = doc.getRoot().listAnimations()[0]
  expect(clip?.getName()).toBe('Throw_Dynamite')
  let moving = 0
  let stationaryError = 0
  for (const channel of clip?.listChannels() ?? []) {
    const output = channel.getSampler()?.getOutput()
    if (!output) {
      throw new Error('Missing throw channel')
    }
    const first = output.getElement(0, [])
    const last = output.getElement(output.getCount() - 1, [])
    for (let i = 0; i < first.length; i++) {
      expect(last[i]).toBeCloseTo(first[i] ?? 0, 6)
    }
    const stationary =
      !['Chest', 'UpperArmR', 'LowerArmR', 'WristR', 'UpperArmL', 'LowerArmL', 'WristL'].includes(
        channel.getTargetNode()?.getName() ?? '',
      ) || channel.getTargetPath() !== 'rotation'
    for (let frame = 1; frame < output.getCount(); frame++) {
      const values = output.getElement(frame, [])
      for (let i = 0; i < values.length; i++) {
        expect(Number.isFinite(values[i])).toBe(true)
        if (stationary) {
          stationaryError = Math.max(
            stationaryError,
            Math.abs(Number(values[i]) - Number(first[i])),
          )
        } else if (Math.abs(Number(values[i]) - Number(first[i])) > 0.1) {
          moving++
        }
      }
    }
  }
  expect(moving).toBeGreaterThan(100)
  expect(stationaryError).toBe(0)
})
it('both standing and crouched tosses are published as native clips', async () => {
  const doc = await io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb')
  for (const name of ['Throw_Dynamite', 'Crouch_Throw_Dynamite']) {
    const clip = doc
      .getRoot()
      .listAnimations()
      .find((candidate) => candidate.getName() === name)
    expect(clip).toBeDefined()
    const duration = Math.max(
      ...(clip?.listSamplers().map((sampler) => sampler.getInput()?.getMax([])[0] ?? 0) ?? []),
    )
    expect(duration).toBeCloseTo(DYNAMITE_THROW_SECONDS, 6)
  }
})
