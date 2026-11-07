import { expect, it } from 'bun:test'
import { World } from 'cannon-es'
import { Group, Matrix4, Quaternion, Texture, Vector3 } from 'three'
import type { CorpseRig } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { CorpseShadows } from '../src/experiments/out-west/ffa/scene/ragdoll-shadows.ts'

function corpse(x: number, y: number, z: number): CorpsePhysics {
  const rig: CorpseRig = {
    identity: 'actual-life',
    velocity: new Vector3(),
    root: new Group(),
    floor: { value: 0 },
    links: [
      {
        key: 'Hips',
        parent: -1,
        position: new Vector3(x, y, z),
        start: new Vector3(x, y, z),
        end: new Vector3(x, y + 0.2, z),
        rotation: new Quaternion(),
        radius: 0.1,
        mass: 10,
      },
    ],
    pose: () => undefined,
    dispose: () => undefined,
  }
  return new CorpsePhysics(new World(), rig, { velocity: new Vector3(), impulse: new Vector3() })
}

it('moves a bounded contact shadow with the physical corpse and conforms it to the actual supporting slope', () => {
  const root = new Group()
  const map = new Texture()
  const shadows = new CorpseShadows(root, (x) => (x < 10 ? 0 : 5 + (x - 10) * 0.3), map)
  const physical = corpse(2, 0.4, 3)
  try {
    shadows.update([physical])
    expect(shadows.mesh.count).toBe(1)
    const matrix = new Matrix4()
    shadows.mesh.getMatrixAt(0, matrix)
    const position = new Vector3().setFromMatrixPosition(matrix)
    expect(position.toArray()).toEqual([2, expect.closeTo(0.012, 6), 3])
    const part = physical.parts[0]
    if (!part) {
      throw new Error('Missing actual physical root')
    }
    part.body.interpolatedPosition.set(12, 6.1, 9)
    shadows.update([physical])
    shadows.mesh.getMatrixAt(0, matrix)
    const rotation = new Quaternion()
    matrix.decompose(position, rotation, new Vector3())
    expect(position.toArray()).toEqual([12, expect.closeTo(5.612, 5), 9])
    const normal = new Vector3(0, 1, 0).applyQuaternion(rotation)
    expect(normal.distanceTo(new Vector3(-0.3, 1, 0).normalize())).toBeLessThan(1e-6)
    // An airborne corpse receives no false contact spot at its old standing/death point.
    part.body.interpolatedPosition.y = 15
    shadows.update([physical])
    expect(shadows.mesh.count).toBe(0)
  } finally {
    physical.dispose()
    shadows.dispose()
  }
})

it('removes hidden, released and real-shadow-tier blobs and disposes its single batch resources', () => {
  const root = new Group()
  const texture = new Texture()
  const shadows = new CorpseShadows(root, () => 0, texture)
  const physical = corpse(2, 0.4, 3)
  const disposed = { texture: 0, geometry: 0, material: 0 }
  texture.addEventListener('dispose', () => disposed.texture++)
  shadows.mesh.geometry.addEventListener('dispose', () => disposed.geometry++)
  shadows.mesh.material.addEventListener('dispose', () => disposed.material++)
  try {
    shadows.update(Array.from({ length: 40 }, () => physical))
    expect(shadows.mesh.count).toBe(32)
    physical.setVisible(false)
    shadows.update([physical])
    expect(shadows.mesh.count).toBe(0)
    physical.setVisible(true)
    shadows.mesh.visible = false
    shadows.update([physical])
    expect(shadows.mesh.count).toBe(0)
    shadows.mesh.visible = true
    shadows.update([physical])
    expect(shadows.mesh.count).toBe(1)
    shadows.update([])
    expect(shadows.mesh.count).toBe(0)
  } finally {
    physical.dispose()
    shadows.dispose()
  }
  expect(root.children).toHaveLength(0)
  expect(disposed).toEqual({ texture: 1, geometry: 1, material: 1 })
})
