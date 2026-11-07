import { expect, it } from 'bun:test'
import { Body, ConeTwistConstraint, Sphere, Vec3, World } from 'cannon-es'
import { Quaternion, Vector3 } from 'three'
import type { CorpseLink } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { corpseJoint } from '../src/experiments/out-west/ffa/scene/ragdoll-joints.ts'
import { CorpseSolver } from '../src/experiments/out-west/ffa/scene/ragdoll-solver.ts'

it('uses unit twist references for an oblique neutral ankle and leaves permitted rotation torque-free', () => {
  const ankle = new Vector3(0, -0.4, 0)
  const direction = new Vector3(0.894, -0.448, 0).normalize()
  const parent: CorpseLink = {
    key: 'LowerLegL',
    parent: -1,
    position: new Vector3(),
    start: new Vector3(),
    end: ankle,
    rotation: new Quaternion(),
    radius: 0.05,
    mass: 1,
    restPosition: new Vector3(),
    restEnd: ankle,
    restRotation: new Quaternion(),
  }
  const child: CorpseLink = {
    key: 'FootL',
    parent: 0,
    position: ankle,
    start: ankle,
    end: ankle.clone().addScaledVector(direction, 0.15),
    rotation: new Quaternion().setFromAxisAngle(direction, Math.PI / 90),
    radius: 0.05,
    mass: 1,
    restPosition: ankle,
    restEnd: ankle.clone().addScaledVector(direction, 0.15),
    restRotation: new Quaternion(),
  }
  const a = new Body({ mass: 0, shape: new Sphere(0.05) })
  const b = new Body({ mass: 1, shape: new Sphere(0.05), position: new Vec3(0, -0.4, 0) })
  b.quaternion.set(child.rotation.x, child.rotation.y, child.rotation.z, child.rotation.w)
  const joint = corpseJoint({ body: a, link: parent }, { body: b, link: child })
  if (!(joint instanceof ConeTwistConstraint)) {
    throw new Error('Ankle must retain its cone and twist constraints')
  }
  joint.update()
  expect(joint.twistEquation.axisA.length()).toBeCloseTo(1, 12)
  expect(joint.twistEquation.axisB.length()).toBeCloseTo(1, 12)
  expect(joint.twistEquation.axisA.dot(joint.twistEquation.axisB)).toBeGreaterThan(
    Math.cos(joint.twistAngle),
  )
  expect(joint.twistEquation.computeB(1 / 120)).toBeGreaterThan(0)
  const world = new World()
  const solver = new CorpseSolver()
  solver.iterations = 24
  world.solver = solver
  world.addBody(a)
  world.addBody(b)
  world.addConstraint(joint)
  const initial = b.quaternion.clone()
  for (let step = 0; step < 240; step++) {
    world.step(1 / 120)
  }
  expect(b.angularVelocity.length()).toBeLessThan(1e-12)
  expect(b.quaternion.toArray()).toEqual(initial.toArray())
  expect(joint.twistEquation.multiplier).toBe(0)
})
