import { expect, it } from 'bun:test'
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  MeshBasicMaterial,
  Vector3,
} from 'three'
import { bake, type Piece } from '../src/experiments/out-west/scene/bake.ts'
import { mergePieces } from '../src/experiments/out-west/scene/piece-merge.ts'
import { SLOT } from '../src/experiments/out-west/scene/roles.ts'

function triangle(x: number, indexed: boolean): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute([x, 0, 0, x + 1, 0, 0, x, 1, 0], 3))
  geo.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  geo.setAttribute(
    'color',
    new Float32BufferAttribute([0.2, 0.3, 0.4, 0.3, 0.4, 0.5, 0.4, 0.5, 0.6], 3),
  )
  geo.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2))
  if (indexed) {
    geo.setIndex([0, 1, 2])
  }
  return geo
}
function piece(x: number, indexed: boolean, bone: number): Piece {
  return {
    geo: triangle(x, indexed),
    roughness: 0.8,
    roughnessAt: new Float32Array([0.4, 0.5, 0.6]),
    rim: 0.7,
    swatch: 'atlas',
    slot: SLOT.Shirt,
    skin: {
      index: new Uint16Array([bone, 0, 0, 0, bone, 0, 0, 0, bone, 0, 0, 0]),
      weight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    },
    paletteSlot: 2,
    palette: new Uint8Array([2, 0, 5]),
  }
}
it('draws every indexed and non-indexed triangle, preserving attributes and translated material groups', () => {
  const a = piece(0, true, 0)
  const b = piece(2, false, 1)
  a.geo.addGroup(0, 3, 2)
  b.geo.addGroup(0, 3, 1)
  const geo = mergePieces([a, b])
  expect(Array.from(geo.index?.array ?? [])).toEqual([0, 1, 2, 3, 4, 5])
  expect(geo.groups).toEqual([
    { start: 0, count: 3, materialIndex: 2 },
    { start: 3, count: 3, materialIndex: 1 },
  ])
  for (const [offset, source] of [
    [0, a],
    [3, b],
  ] as const) {
    for (const key of ['position', 'normal', 'color', 'uv']) {
      const from = source.geo.getAttribute(key)
      const to = geo.getAttribute(key)
      for (let vertex = 0; vertex < from.count; vertex++) {
        for (let c = 0; c < from.itemSize; c++) {
          expect(to.getComponent(offset + vertex, c)).toBe(from.getComponent(vertex, c))
        }
      }
    }
    expect(geo.getAttribute('styMat').getX(offset)).toBeCloseTo(0.4)
    expect(geo.getAttribute('styMat').getY(offset)).toBeCloseTo(0.7)
  }
})
it('retains drawn non-indexed tailoring skin and palette through fitted occlusion and bone compaction', () => {
  const root = new Group()
  const head = new Bone()
  head.name = 'Head'
  const chest = new Bone()
  chest.name = 'Chest'
  root.add(head, chest)
  root.updateMatrixWorld(true)
  const a = piece(0, true, 0)
  const b = piece(2, false, 1)
  b.geo.addGroup(0, 3, 3)
  const hidden = piece(4, false, 1)
  hidden.hide = (p) => p.x >= 4
  const mesh = bake(
    [a, b, hidden],
    { samples: [], bones: [head, chest] },
    root,
    new MeshBasicMaterial(),
  )
  expect(Array.from(mesh.geometry.index?.array ?? [])).toEqual([0, 1, 2, 3, 4, 5])
  expect(mesh.geometry.groups).toEqual([
    { start: 0, count: 3, materialIndex: 0 },
    { start: 3, count: 3, materialIndex: 3 },
    { start: 6, count: 0, materialIndex: 0 },
  ])
  expect(Array.from(mesh.geometry.getAttribute('paletteSlot').array)).toEqual([
    2, 0, 5, 2, 0, 5, 2, 0, 5,
  ])
  const indices = mesh.geometry.getAttribute('skinIndex')
  expect(mesh.skeleton.bones[indices.getX(0)]).toBe(head)
  expect(mesh.skeleton.bones[indices.getX(3)]).toBe(chest)
  mesh.skeleton.update()
  expect(mesh.getVertexPosition(3, new Vector3()).toArray()).toEqual([2, 0, 0])
  mesh.skeleton.dispose()
})
