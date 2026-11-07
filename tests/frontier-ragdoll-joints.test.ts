import { beforeAll, describe, expect, it } from 'bun:test'
import { file } from 'bun'
import {
  Body,
  ConeTwistConstraint,
  GSSolver,
  HingeConstraint,
  Sphere,
  Vec3,
  World,
} from 'cannon-es'
import { type AnimationClip, Bone, Group, type Matrix4, Quaternion, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey } from '../src/experiments/out-west/data/outlaws.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import {
  type CorpseLink,
  cloneCorpse,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { corpseJoint } from '../src/experiments/out-west/ffa/scene/ragdoll-joints.ts'
import { Actor, type Clip } from '../src/experiments/out-west/scene/actor.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const models = new Map<BodyKey, GLTF>()
const importedRest = new Map<BodyKey, Map<string, Matrix4>>()
let clips: AnimationClip[] = []
beforeAll(async () => {
  const load = async (name: string) =>
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(
        await file(
          new URL(`../public/experiments/out-west/3d/models/${name}.glb`, import.meta.url),
        ).arrayBuffer(),
        '',
      )
  const [player, moves] = await Promise.all([load('player'), load('moves')])
  clips = [...player.animations, ...moves.animations]
  await Promise.all(
    bases.map(async (base) => {
      const model = await load(base)
      markCharacterSlots(model)
      models.set(base, model)
      model.scene.updateMatrixWorld(true)
      const inverse = model.scene.matrixWorld.clone().invert()
      const frames = new Map<string, Matrix4>()
      model.scene.traverse((node) => {
        if (node instanceof Bone) {
          frames.set(boneKey(node.name), inverse.clone().multiply(node.matrixWorld))
        }
      })
      importedRest.set(base, frames)
    }),
  )
})

function actorFor(base: BodyKey, pose: Clip) {
  const model = models.get(base)
  if (!model) {
    throw new Error(`Missing actual ${base} model`)
  }
  const actor = new Actor(model, { base, clips, seed: 'ragdoll-joint-review' })
  new Group().add(actor.root)
  actor.root.position.set(20, 4, 64)
  actor.root.scale.setScalar(1.25)
  if (!actor.action(pose)) {
    throw new Error(`Missing actual ${base}/${pose} capture clip`)
  }
  actor.play(pose, 0)
  actor.update(0.37)
  actor.root.updateMatrixWorld(true)
  const geometry = actor.meshes[0]?.geometry
  if (!geometry) {
    throw new Error(`No real skin on ${base}`)
  }
  ownGeometry(geometry)
  return { actor, geometry }
}

function neutralFrame(base: BodyKey, actor: Actor, key: string) {
  const imported = importedRest.get(base)?.get(key)
  if (!imported) {
    throw new Error(`Original ${base} has no neutral ${key} frame`)
  }
  const neutral = actor.model.matrixWorld.clone().multiply(imported)
  const position = new Vector3()
  const rotation = new Quaternion()
  neutral.decompose(position, rotation, new Vector3())
  return { position, rotation }
}

const cv = (v: Vector3) => new Vec3(v.x, v.y, v.z)
type BoundLink = CorpseLink & {
  restEnd: Vector3
  restPosition: Vector3
  restRotation: Quaternion
}
function requireRest(link: CorpseLink): asserts link is BoundLink {
  if (!(link.restEnd && link.restPosition && link.restRotation)) {
    throw new Error(`Missing imported inverse-bind frame for ${link.key}`)
  }
}
const restDirection = (link: CorpseLink) => {
  requireRest(link)
  return link.restEnd.clone().sub(link.restPosition).normalize()
}
function restLink(link: CorpseLink): CorpseLink {
  requireRest(link)
  return {
    ...link,
    position: link.restPosition.clone(),
    start: link.restPosition.clone(),
    end: link.restEnd.clone(),
    rotation: link.restRotation.clone(),
  }
}

function bindAngle(parent: CorpseLink, child: CorpseLink, reference: Vector3): number {
  requireRest(parent)
  requireRest(child)
  const atParent = reference
    .clone()
    .applyQuaternion(parent.restRotation.clone().invert())
    .applyQuaternion(parent.rotation)
    .normalize()
  const atChild = reference
    .clone()
    .applyQuaternion(child.restRotation.clone().invert())
    .applyQuaternion(child.rotation)
    .normalize()
  return Math.acos(Math.max(-1, Math.min(1, atParent.dot(atChild))))
}

function hingeRange(parent: CorpseLink, child: CorpseLink, speed: number, frequency: number) {
  const p = restLink(parent)
  const c = restLink(child)
  const a = new Body({ mass: 0, shape: new Sphere(0.05), position: cv(p.position) })
  const b = new Body({ mass: 1, shape: new Sphere(0.05), position: cv(c.position) })
  a.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
  b.quaternion.set(c.rotation.x, c.rotation.y, c.rotation.z, c.rotation.w)
  const joint = corpseJoint({ body: a, link: p }, { body: b, link: c })
  if (!(joint instanceof HingeConstraint)) {
    throw new Error(`${c.key} has no real hinge`)
  }
  const step = 1 / frequency
  for (const [index, equation] of joint.equations.entries()) {
    equation.setSpookParams(index < 3 ? 1e9 : 1e7, 4, step)
  }
  const axis = a.vectorToWorldFrame(joint.axisA)
  const along = restDirection(p)
  const localChild = restDirection(c).applyQuaternion(c.rotation.clone().invert())
  const world = new World()
  const solver = new GSSolver()
  solver.iterations = 14
  world.solver = solver
  world.addBody(a)
  world.addBody(b)
  world.addConstraint(joint)
  b.angularVelocity.copy(axis.scale(speed))
  let lo = 0
  let hi = 0
  for (let i = 0; i < 3 * frequency; i++) {
    world.step(step)
    const q = new Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w)
    const direction = localChild.clone().applyQuaternion(q)
    const cross = along.clone().cross(direction)
    const angle = Math.atan2(cross.dot(new Vector3(axis.x, axis.y, axis.z)), along.dot(direction))
    lo = Math.min(lo, angle)
    hi = Math.max(hi, angle)
  }
  return { lo, hi }
}

for (const base of bases) {
  describe(`actual ${base} corpse rig`, () => {
    it('preserves captured Idle/Run/ADS/crouch poses and rest-frame angles at different world yaws', () => {
      for (const pose of ['Idle', 'Run', 'Idle_Gun_Pointing', 'Crouch_Idle'] as const) {
        const { actor, geometry } = actorFor(base, pose)
        const angles: number[][] = []
        try {
          for (const yaw of [0, 0.73]) {
            actor.root.rotation.y = yaw
            actor.root.updateMatrixWorld(true)
            const rig = cloneCorpse(actor, geometry, `${base}/${pose}/${yaw}`)
            const bones = new Map<string, Bone>()
            rig.root.traverse((node) => {
              if (node instanceof Bone) {
                bones.set(boneKey(node.name), node)
              }
            })
            const physics = new CorpsePhysics(new World(), rig, {
              velocity: new Vector3(),
              impulse: new Vector3(),
            })
            try {
              expect(rig.links).toHaveLength(18)
              for (const link of rig.links) {
                const bone = bones.get(link.key)
                if (!bone) {
                  throw new Error(`Captured rig lost ${base}/${link.key}`)
                }
                expect(bone.getWorldPosition(new Vector3()).distanceTo(link.position)).toBeLessThan(
                  0.0001,
                )
                expect(
                  Math.abs(
                    bone
                      .getWorldQuaternion(new Quaternion())
                      .normalize()
                      .dot(link.rotation.clone().normalize()),
                  ),
                ).toBeCloseTo(1, 6)
                restDirection(link)
                requireRest(link)
                // The oracle is the untouched imported hierarchy, before Actor plays Idle.
                // Render inverse binds are intentionally baked in Idle and cannot be the oracle.
                const { position, rotation } = neutralFrame(base, actor, link.key)
                expect(link.restPosition.distanceTo(position)).toBeLessThan(0.0001)
                expect(Math.abs(link.restRotation.dot(rotation))).toBeCloseTo(1, 6)
              }
              angles.push(
                physics.constraints.flatMap((joint) => {
                  joint.update()
                  if (!(joint instanceof ConeTwistConstraint)) {
                    return []
                  }
                  const { axisA, axisB } = joint.coneEquation
                  // Posed GLB matrix decomposition carries a few ppm of norm error.
                  expect(axisA.length()).toBeCloseTo(1, 4)
                  expect(axisB.length()).toBeCloseTo(1, 4)
                  const cosine = axisA.dot(axisB) / (axisA.length() * axisB.length())
                  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)))
                  const parent = physics.parts.find((part) => part.body === joint.bodyA)?.link
                  const child = physics.parts.find((part) => part.body === joint.bodyB)?.link
                  if (!(parent && child)) {
                    throw new Error('Constraint lost its actual anatomical parts')
                  }
                  const reference = restDirection(child)
                  expect(angle).toBeCloseTo(bindAngle(parent, child, reference), 4)
                  const tangent = new Vec3()
                  cv(reference).tangents(tangent, new Vec3())
                  const twist = joint.twistEquation
                  expect(twist.axisA.length()).toBeCloseTo(1, 4)
                  expect(twist.axisB.length()).toBeCloseTo(1, 4)
                  const twistCosine =
                    twist.axisA.dot(twist.axisB) / (twist.axisA.length() * twist.axisB.length())
                  expect(Math.acos(Math.max(-1, Math.min(1, twistCosine)))).toBeCloseTo(
                    bindAngle(parent, child, new Vector3(tangent.x, tangent.y, tangent.z)),
                    4,
                  )
                  return [angle]
                }),
              )
            } finally {
              physics.dispose()
            }
          }
          expect(angles[0]?.length).toBeGreaterThan(0)
          for (const [i, angle] of (angles[0] ?? []).entries()) {
            // Near-zero acos magnifies float GLB matrix decomposition error; allow 0.06 degrees.
            expect(Math.abs((angles[1]?.[i] ?? Number.POSITIVE_INFINITY) - angle)).toBeLessThan(
              0.001,
            )
          }
        } finally {
          releaseGeometry(geometry)
          actor.dispose()
        }
      }
    })

    it('keeps actual imported neutral cone and twist rows inactive with raw unit axes', () => {
      const { actor, geometry } = actorFor(base, 'Idle')
      const rig = cloneCorpse(actor, geometry, `${base}/neutral`)
      try {
        for (const child of rig.links) {
          const parent = rig.links[child.parent]
          if (!parent) {
            continue
          }
          const p = restLink(parent)
          const c = restLink(child)
          const a = new Body({ mass: 0, shape: new Sphere(0.05), position: cv(p.position) })
          const b = new Body({ mass: 1, shape: new Sphere(0.05), position: cv(c.position) })
          a.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
          b.quaternion.set(c.rotation.x, c.rotation.y, c.rotation.z, c.rotation.w)
          const joint = corpseJoint({ body: a, link: p }, { body: b, link: c })
          if (!(joint instanceof ConeTwistConstraint)) {
            continue
          }
          const world = new World()
          world.addBody(a)
          world.addBody(b)
          joint.update()
          expect(joint.twistEquation.axisA.length()).toBeCloseTo(1, 6)
          expect(joint.twistEquation.axisB.length()).toBeCloseTo(1, 6)
          // The solver consumes this raw dot product, not a normalized angle.
          expect(joint.twistEquation.axisA.dot(joint.twistEquation.axisB)).toBeGreaterThan(
            Math.cos(joint.twistAngle),
          )
          const solver = new GSSolver()
          for (const row of joint.equations) {
            solver.addEquation(row)
          }
          solver.solve(1 / 120, world)
          expect(joint.coneEquation.multiplier).toBe(0)
          expect(joint.twistEquation.multiplier).toBe(0)
          expect(b.angularVelocity.length()).toBeLessThan(1e-8)
        }
      } finally {
        rig.dispose()
        releaseGeometry(geometry)
        actor.dispose()
      }
    })

    it.each([60, 120])(
      'enforces signed elbow/knee limits at %iHz using imported anatomical frames',
      (frequency) => {
        const { actor, geometry } = actorFor(base, 'Idle')
        const rig = cloneCorpse(actor, geometry, `${base}/limits`)
        try {
          for (const key of ['LowerArmL', 'LowerArmR', 'LowerLegL', 'LowerLegR'] as const) {
            const child = rig.links.find((link) => link.key === key)
            const parent = child ? rig.links[child.parent] : undefined
            if (!(child && parent)) {
              throw new Error(`Missing imported ${base}/${key}`)
            }
            const reverse = hingeRange(parent, child, -10, frequency)
            const forward = hingeRange(parent, child, 10, frequency)
            const maximum = ((key.startsWith('LowerArm') ? 155 : 145) * Math.PI) / 180
            expect(reverse.lo).toBeGreaterThan(-0.04)
            expect(forward.lo).toBeGreaterThan(-0.04)
            expect(forward.hi).toBeGreaterThan(1)
            expect(forward.hi).toBeLessThan(maximum + 0.04)
          }
        } finally {
          rig.dispose()
          releaseGeometry(geometry)
          actor.dispose()
        }
      },
    )
  })
}
