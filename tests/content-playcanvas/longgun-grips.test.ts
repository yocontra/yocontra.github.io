import { expect, test as it } from 'bun:test'
import { existsSync } from 'node:fs'
import { type Animation, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const source = 'tools/art/characters'
const KINDS = ['rifle', 'shotgun'].filter((kind) =>
  existsSync(`${source}/longgun-grips/${kind}.glb`),
)

function tracks(clip: Animation | undefined): Map<string, number[]> {
  return new Map(
    (clip?.listChannels() ?? []).map((channel) => [
      `${channel.getTargetNode()?.getName()}.${channel.getTargetPath()}`,
      Array.from(channel.getSampler()?.getOutput()?.getArray() ?? []),
    ]),
  )
}

it('long-gun grips are current, gun-locked between keys and preserve every unowned channel', async () => {
  expect(KINDS).toContain('rifle')
  const moves = await io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb')
  const baked = (name: string) =>
    moves
      .getRoot()
      .listAnimations()
      .find((clip) => clip.getName() === name)
  for (const kind of KINDS) {
    const grip = await io.read(`${source}/longgun-grips/${kind}.glb`)
    await validateAuthoringInputs(grip)
    const extras = grip.getRoot().getExtras() as {
      changedBones: string[]
      report: Record<
        string,
        {
          wristDeviationDegrees: number
          validation: Record<
            string,
            {
              driftMm: number
              fleshDepthMm: number
              palmGapMm: number
              sightIntrusionMm: number
              triggerGapMm?: number
            }
          >
        }
      >
    }
    expect(Object.keys(extras.report)).toContain('L')
    for (const side of Object.values(extras.report)) {
      expect(Math.abs(side.wristDeviationDegrees)).toBeLessThanOrEqual(45)
      for (const metrics of Object.values(side.validation)) {
        expect(metrics.driftMm).toBeLessThan(0.5)
        expect(metrics.fleshDepthMm).toBeLessThan(1.5)
        expect(metrics.palmGapMm).toBeLessThan(1.5)
        expect(metrics.sightIntrusionMm).toBe(0)
        expect(metrics.triggerGapMm ?? 0).toBeLessThan(2)
      }
    }
    const probes = Object.keys(extras.report).flatMap((side) =>
      ['UpperArm', 'Index2', 'Thumb1'].map((bone) => bone + side),
    )
    const actions = await io.read(`${source}/held-actions-${kind}.glb`)
    for (const name of [`Hold_${kind}`, `Shoot_${kind}`]) {
      const find = (doc: typeof grip) =>
        doc
          .getRoot()
          .listAnimations()
          .find((clip) => clip.getName() === name)
      const authored = tracks(find(grip))
      const original = tracks(find(actions))
      const order = (a: string, b: string) => a.localeCompare(b)
      expect([...authored.keys()].sort(order)).toEqual([...original.keys()].sort(order))
      const unowned = [...authored].filter(
        ([key]) =>
          !(
            extras.changedBones.includes(key.slice(0, key.lastIndexOf('.'))) &&
            key.endsWith('.rotation')
          ),
      )
      expect(unowned.length).toBeGreaterThan(authored.size / 2)
      for (const [key, values] of unowned) {
        expect(values).toEqual(original.get(key) ?? [])
      }
      for (const clip of [name, `Crouch_${name}`]) {
        const runtime = tracks(baked(clip))
        for (const bone of probes) {
          const expected = authored.get(`${bone}.rotation`)?.slice(0, 4) ?? []
          const actual = runtime.get(`${bone}.rotation`)?.slice(0, 4) ?? []
          expect(
            actual.map((v, i) => Math.abs(v - (expected[i] ?? 0))).every((d) => d < 1e-5),
          ).toBe(true)
        }
      }
    }
  }
})
