import { expect, test as it } from 'bun:test'
import { type Animation, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const path = 'tools/art/characters/gestures/tip-hat.glb'

function applyFrame(clip: Animation, frame: number) {
  for (const channel of clip.listChannels()) {
    const node = channel.getTargetNode()
    const value = channel.getSampler()?.getOutput()?.getElement(frame, [])
    if (!(node && value)) {
      throw new Error('Incomplete authored gesture channel')
    }
    const [x = 0, y = 0, z = 0, w = 1] = value
    switch (channel.getTargetPath()) {
      case 'rotation':
        node.setRotation([x, y, z, w])
        break
      case 'translation':
        node.setTranslation([x, y, z])
        break
      case 'scale':
        node.setScale([x, y, z])
        break
      default:
        throw new Error('Gesture must contain only native joint transforms')
    }
  }
}

it('authored victory gesture lasts 1.5 seconds, plants both feet, reaches the brim and returns to idle', async () => {
  const doc = await io.read(path)
  await validateAuthoringInputs(doc)
  const clip = doc.getRoot().listAnimations()[0]
  if (!clip) {
    throw new Error('Missing TipHat')
  }
  expect(clip.getName()).toBe('TipHat')
  const nodes = new Map(
    doc
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  )
  const position = (name: string) => nodes.get(name)?.getWorldMatrix().slice(12, 15) ?? []
  const duration = Math.max(
    ...clip.listSamplers().map((sampler) => sampler.getInput()?.getMax([])[0] ?? 0),
  )
  expect(duration).toBe(1.5)
  applyFrame(clip, 0)
  const feet = [position('FootL'), position('FootR')]
  const startWrist = position('WristR')
  const changed = new Set(['Head', 'Chest', 'UpperArmR', 'LowerArmR', 'WristR'])
  let unownedMotion = 0
  for (const channel of clip.listChannels()) {
    const values = channel.getSampler()?.getOutput()
    if (!values) {
      throw new Error('Missing gesture samples')
    }
    expect(values.getCount()).toBe(91)
    const start = values.getElement(0, [])
    expect(
      values
        .getElement(90, [])
        .map((v, i) => Math.abs(v - (start[i] ?? 0)))
        .every((v) => v < 1e-5),
    ).toBe(true)
    if (
      channel.getTargetPath() !== 'rotation' ||
      !changed.has(channel.getTargetNode()?.getName() ?? '')
    ) {
      for (let frame = 0; frame <= 90; frame++) {
        unownedMotion = Math.max(
          unownedMotion,
          ...values.getElement(frame, []).map((v, i) => Math.abs(v - (start[i] ?? 0))),
        )
      }
    }
  }
  expect(unownedMotion).toBeLessThan(1e-5)
  for (let frame = 0; frame <= 90; frame++) {
    applyFrame(clip, frame)
    for (const [index, foot] of ['FootL', 'FootR'].entries()) {
      expect(
        position(foot)
          .map((v, i) => Math.abs(v - (feet[index]?.[i] ?? 0)))
          .every((v) => v < 1e-6),
      ).toBe(true)
    }
  }
  applyFrame(clip, 45)
  const head = position('Head')
  const wrist = position('WristR')
  const target = [(head[0] ?? 0) - 0.07, (head[1] ?? 0) + 0.17, (head[2] ?? 0) + 0.15]
  expect(Math.hypot(...wrist.map((v, i) => v - (target[i] ?? 0)))).toBeLessThan(0.001)
  expect((wrist[1] ?? 0) - (startWrist[1] ?? 0)).toBeGreaterThan(0.65)
})

it('the production moves container includes the authored victory gesture', async () => {
  const doc = await io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb')
  const clip = doc
    .getRoot()
    .listAnimations()
    .find((candidate) => candidate.getName() === 'TipHat')
  expect(clip).toBeDefined()
  expect(
    Math.max(
      ...(clip?.listSamplers().map((sampler) => sampler.getInput()?.getMax([])[0] ?? 0) ?? []),
    ),
  ).toBe(1.5)
  expect(
    clip?.listChannels().some((channel) => channel.getTargetNode()?.getName() === 'WristR'),
  ).toBe(true)
})
