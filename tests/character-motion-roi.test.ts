import { expect, it } from 'bun:test'
import { Bone, Box3, Group, Vector3 } from 'three'
import type { FrontierGame } from '../src/experiments/out-west/ffa/client/game.ts'
import { corpseFrames } from '../tools/character-quality/frame-mapping.ts'

it('frames the fallen measured body without the unweighted capture-root marker', () => {
  const root = new Group()
  const imported = new Bone()
  imported.name = 'Root'
  imported.position.set(40, 20, -30)
  const foot = new Bone()
  foot.name = 'FootL'
  foot.position.set(2, 0.12, 3)
  root.add(imported, foot)
  root.updateMatrixWorld(true)
  const measured = new Box3(new Vector3(1, 0, 2), new Vector3(3, 0.6, 4))
  const saved = measured.clone()
  const game = {
    ragdolls: {
      corpses: new Map([
        [
          7,
          {
            physics: {
              rig: { root },
              worldBounds: measured,
              parts: [{ link: { key: 'FootL' }, pose: { position: foot.position.clone() } }],
            },
          },
        ],
        [8, { physics: null }],
      ]),
    },
  } as unknown as FrontierGame
  const result = corpseFrames(game)
  expect(result.bounds.equals(saved)).toBe(true)
  expect(result.bounds.containsPoint(imported.position)).toBe(false)
  expect(result.mapping).toHaveLength(1)
  expect(result.mapping[0]?.drivers).toBe(1)
  expect(result.mapping[0]?.maxOriginError).toBe(0)
  result.bounds.expandByScalar(10)
  expect(measured.equals(saved)).toBe(true)
})
