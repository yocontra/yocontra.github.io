import { expect, it } from 'bun:test'
import { Body, Sphere, Vec3, World } from 'cannon-es'
import { Group, Quaternion, Vector3 } from 'three'
import type { CorpseRig } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'

function measured(yaw: number): CorpsePhysics {
  const position = new Vector3(5, 2, 6)
  const rig: CorpseRig = {
    identity: 'fitted-player',
    root: new Group(),
    velocity: new Vector3(),
    links: [
      {
        key: 'Hips',
        parent: -1,
        position,
        rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
        start: position.clone(),
        end: position.clone().add(new Vector3(0, 0.4, 0)),
        center: new Vector3(0, 0.2, 0),
        halfExtents: new Vector3(0.2, 0.4, 0.1),
        radius: 0.1,
        mass: 10,
        contacts: [{ center: new Vector3(0.3, 0.1, 0), radius: 0.02 }],
      },
    ],
    floor: { value: 0 },
    pose: () => undefined,
    dispose: () => undefined,
  }
  return new CorpsePhysics(new World(), rig, { velocity: new Vector3(), impulse: new Vector3() })
}

it('matches identity-frame compound addShape properties and keeps local inertia invariant under world yaw', () => {
  const reference = new Body({ mass: 10, position: new Vec3(5, 2.2, 6) })
  for (const x of [-0.1, 0.1]) {
    for (const y of [-0.3, 0.3]) {
      reference.addShape(new Sphere(0.1), new Vec3(x, y, 0))
    }
  }
  reference.addShape(new Sphere(0.02), new Vec3(0.3, -0.1, 0))
  reference.updateAABB()
  for (const yaw of [0, Math.PI / 4, Math.PI / 2]) {
    const physical = measured(yaw)
    try {
      const body = physical.parts[0]?.body
      if (!body) {
        throw new Error('Missing measured physical body')
      }
      expect(body.mass).toBe(reference.mass)
      expect(body.invMass).toBe(reference.invMass)
      expect(body.inertia.distanceTo(reference.inertia)).toBeLessThan(1e-10)
      expect(body.boundingRadius).toBeCloseTo(reference.boundingRadius, 10)
      expect(body.shapes).toHaveLength(reference.shapes.length)
      for (const [index, shape] of body.shapes.entries()) {
        const referenceShape = reference.shapes[index]
        if (!(shape instanceof Sphere && referenceShape instanceof Sphere)) {
          throw new Error('Measured compound must retain its exact spherical supports')
        }
        expect(shape.body).toBe(body)
        expect(shape.type).toBe(referenceShape.type)
        expect(shape.radius).toBe(referenceShape.radius)
        expect(
          body.shapeOffsets[index]?.distanceTo(reference.shapeOffsets[index] ?? new Vec3()),
        ).toBeLessThan(1e-10)
        expect(body.shapeOrientations[index]?.toArray()).toEqual([0, 0, 0, 1])
      }
      reference.quaternion.copy(body.quaternion)
      reference.updateInertiaWorld(true)
      reference.updateAABB()
      expect(body.invInertiaWorld.elements).toEqual(reference.invInertiaWorld.elements)
      expect(body.aabb.lowerBound.distanceTo(reference.aabb.lowerBound)).toBeLessThan(1e-10)
      expect(body.aabb.upperBound.distanceTo(reference.aabb.upperBound)).toBeLessThan(1e-10)
      // Restore the reference identity frame; its local principal inertia remains unchanged.
      reference.quaternion.set(0, 0, 0, 1)
    } finally {
      physical.dispose()
    }
  }
})
