import { expect, it } from 'bun:test'
import { Group, Mesh } from 'three'
import { type Measure, qDelta, renderedPose, translationOf } from '../tools/anim/lib.ts'

it('measures rendered quaternion angles independently of transform-scale drift', () => {
  const turn = Math.PI / 12
  expect(qDelta([0, 0, 0, 1.1], [0, Math.sin(turn) * 1.1, 0, Math.cos(turn) * 1.1])).toBeCloseTo(
    30,
    8,
  )
  expect(qDelta([0, 0, 0, 1], [0, 0, 0, -1])).toBe(0)
})

it('observes the rendered gun matrix without updating a manually posed hierarchy', () => {
  const root = new Group()
  const mesh = new Mesh()
  root.add(mesh)
  mesh.matrixWorld.makeTranslation(0, 0.01, 0)
  mesh.updateWorldMatrix = () => {
    throw new Error('Observer must not recompose the rendered hierarchy')
  }
  const pose = renderedPose(root)
  expect(pose.pos).toEqual([0, 0.01, 0])
  expect(pose.q).toEqual([0, 0, 0, 1])
  expect(mesh.matrixWorld.elements[13]).toBe(0.01)
})

it('measures first-person translation independently of a stable bone hold', () => {
  const frame = (renderPos: number[]) => ({ renderPos }) as Measure
  expect(translationOf([frame([0, 0, 0]), frame([0, 0.0018, 0])])).toBeCloseTo(0.0018, 8)
  expect(translationOf([frame([0, 0, 0]), frame([0, 0, 0])])).toBe(0)
})
