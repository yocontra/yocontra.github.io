import { expect, it } from 'bun:test'
import { Bone, BufferGeometry, Float32BufferAttribute, Group } from 'three'
import type { Piece } from '../src/experiments/out-west/scene/bake.ts'
import type { Body } from '../src/experiments/out-west/scene/fit.ts'
import { bindTrouserYoke } from '../src/experiments/out-west/scene/trouser-yoke.ts'

it('anchors the trouser waist to the pelvis with a continuous proximal blend and exact original knees', () => {
  const root = new Group()
  const hips = new Bone()
  hips.name = 'Hips'
  hips.position.y = 1
  root.add(hips)
  const right = new Bone()
  right.name = 'UpperLegR'
  right.position.x = -0.1
  const kneeR = new Bone()
  kneeR.name = 'LowerLegR'
  kneeR.position.y = -0.4
  right.add(kneeR)
  const left = new Bone()
  left.name = 'UpperLegL'
  left.position.x = 0.1
  const kneeL = new Bone()
  kneeL.name = 'LowerLegL'
  kneeL.position.y = -0.4
  left.add(kneeL)
  hips.add(right, left)
  root.updateMatrixWorld(true)
  const body: Body = { bones: [hips, right, kneeR, left, kneeL], samples: [] }
  const geo = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute(
      [-0.1, 0.5, 0, -0.1, 0.7, 0, -0.1, 0.82, 0, -0.1, 1.04, 0, 0.1, 1.04, 0],
      3,
    ),
  )
  const skin = {
    index: Uint16Array.from([2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0]),
    weight: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  }
  const piece: Piece = { geo, skin, roughness: 1, rim: 1 }
  const indices = skin.index.slice()
  const weights = skin.weight.slice()
  const positions = geo.getAttribute('position').array.slice()
  const frames = body.bones.map((bone) => bone.matrixWorld.toArray())
  bindTrouserYoke(piece, body)
  expect(Array.from(skin.index.slice(0, 8))).toEqual(Array.from(indices.slice(0, 8)))
  expect(Array.from(skin.weight.slice(0, 8))).toEqual(Array.from(weights.slice(0, 8)))
  expect(Array.from(geo.getAttribute('position').array)).toEqual(Array.from(positions))
  expect(body.bones.map((bone) => bone.matrixWorld.toArray())).toEqual(frames)
  expect(skin.index[12]).toBe(0)
  expect(skin.weight[12]).toBe(1)
  expect(skin.index[16]).toBe(0)
  expect(skin.weight[16]).toBe(1)
  const middle = Array.from(skin.weight.slice(8, 12))
  expect(middle.filter((weight) => weight > 0)).toHaveLength(2)
  expect(Math.abs(middle.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-7)
  expect(Array.from(skin.weight).every((weight) => weight >= 0 && weight <= 1)).toBe(true)
  geo.dispose()
})
