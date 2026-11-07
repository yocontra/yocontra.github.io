/** Invisible measured rigid bodies drive the independently cloned, fully dressed skin. */
import { Body, type Constraint, type ContactEquation, Sphere, Vec3, type World } from 'cannon-es'
import { Box3, type Quaternion, Vector3 } from 'three'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../contract/town.ts'
import type { RagdollImpact } from '../client/shot-impact.ts'
import { setCorpseDetail } from './corpse-lod.ts'
import type { CorpseGround, CorpseLink, CorpsePose, CorpseRig } from './crowd/corpse-rig.ts'
import { CorpseBroadphase, tagCorpseBody } from './ragdoll-broadphase.ts'
import { corpseJoint, RAGDOLL_STEP } from './ragdoll-joints.ts'
import { limitCorpseVelocity } from './ragdoll-motion.ts'
import type { CorpseView } from './ragdoll-view.ts'

interface Part {
  body: Body
  link: CorpseLink
  offset: Vector3
  pose: CorpsePose
}
const finite = (v: Vector3): boolean => [v.x, v.y, v.z].every(Number.isFinite)
const xyz = (v: Vector3): Vec3 => new Vec3(v.x, v.y, v.z)

function collisionGroup(link: CorpseLink): number {
  const limb: Partial<Record<CorpseLink['key'], number>> = {
    UpperArmL: 4,
    LowerArmL: 4,
    WristL: 4,
    UpperArmR: 8,
    LowerArmR: 8,
    WristR: 8,
    UpperLegL: 16,
    LowerLegL: 16,
    FootL: 16,
    UpperLegR: 32,
    LowerLegR: 32,
    FootR: 32,
    Neck: 64,
    Head: 64,
  }
  return limb[link.key] ?? 2
}

function makePart(link: CorpseLink): Part {
  const center = link.center
    ? link.center.clone().applyQuaternion(link.rotation).add(link.position)
    : link.start.clone().add(link.end).multiplyScalar(0.5)
  const body = new Body({
    mass: Math.max(0.1, Math.min(30, link.mass)),
    position: xyz(center),
    collisionFilterGroup: 2,
    // Contiguous regions do not fight their own overlapping collision envelopes. Other
    // limbs still contact the torso and each other, beyond the connected-joint exclusion.
    collisionFilterMask: 3,
    linearDamping: 0.35,
    angularDamping: 0.55,
    allowSleep: true,
    sleepSpeedLimit: 0.12,
    sleepTimeLimit: 0.8,
  })
  const inverse = link.rotation.clone().invert()
  const origin = link.position.clone().sub(center).applyQuaternion(inverse)
  const massProperties = body.updateMassProperties
  // Cannon derives principal inertia from the current AABB. Build it in the bone's local
  // identity frame, once; a captured world yaw must not change that local mass distribution.
  body.updateMassProperties = () => undefined
  try {
    addShapes(body, link, center, inverse)
    for (const contact of link.contacts ?? []) {
      const radius = Math.max(0.008, Math.min(0.08, contact.radius))
      body.addShape(new Sphere(radius), xyz(contact.center.clone().add(origin)))
    }
  } finally {
    body.updateMassProperties = massProperties
  }
  body.updateMassProperties()
  body.quaternion.set(link.rotation.x, link.rotation.y, link.rotation.z, link.rotation.w)
  body.previousQuaternion.copy(body.quaternion)
  body.interpolatedQuaternion.copy(body.quaternion)
  body.updateInertiaWorld(true)
  body.updateAABB()
  return {
    body,
    link,
    offset: origin,
    pose: { position: link.position.clone(), rotation: link.rotation.clone() },
  }
}

function addShapes(body: Body, link: CorpseLink, center: Vector3, inverse: Quaternion): void {
  if (link.anatomySpheres?.length) {
    const origin = link.position.clone().sub(center).applyQuaternion(inverse)
    for (const support of link.anatomySpheres) {
      body.addShape(new Sphere(support.radius), xyz(support.center.clone().add(origin)))
    }
    return
  }
  if (link.halfExtents && link.center) {
    // Rounded measured boxes preserve the torso/head's real width AND depth. A single broad
    // capsule would hold a rider's flat back visibly above the floor after he falls.
    const extents = link.halfExtents
    const radius = Math.max(0.035, Math.min(0.14, extents.x, extents.y, extents.z))
    const axis = (extent: number) =>
      extent > radius + 0.012 ? [-extent + radius, extent - radius] : [0]
    const shape = new Sphere(radius)
    for (const x of axis(extents.x)) {
      for (const y of axis(extents.y)) {
        for (const z of axis(extents.z)) {
          body.addShape(shape, new Vec3(x, y, z))
        }
      }
    }
    return
  }
  const radius = Math.max(0.035, Math.min(0.19, link.radius))
  const length = link.start.distanceTo(link.end)
  const inset = Math.min(radius, length / 2)
  const intervals = Math.max(0, Math.ceil((length - inset * 2) / (radius * 1.3)))
  const shape = new Sphere(radius)
  for (let i = 0; i <= intervals; i++) {
    const t =
      length > 1e-6 ? (inset + ((length - inset * 2) * i) / Math.max(1, intervals)) / length : 0.5
    const offset = link.start.clone().lerp(link.end, t).sub(center).applyQuaternion(inverse)
    body.addShape(shape, xyz(offset))
  }
}

function applyPose(
  rig: CorpseRig,
  poses: readonly CorpsePose[],
  ground: CorpseGround | undefined,
  state: { suspended: boolean; skipped: boolean },
): void {
  if (state.suspended) {
    rig.resetCloth?.()
  }
  rig.pose(poses, ground)
  state.suspended = false
  state.skipped = false
}

export class CorpsePhysics {
  readonly parts: Part[]
  readonly constraints: Constraint[] = []
  private readonly world: World
  private readonly rig: CorpseRig
  private readonly poses: CorpsePose[]
  private readonly ground: CorpseGround | undefined
  private readonly focus = new Vector3()
  private readonly fallbackBounds = new Box3()
  private worldBounds = this.fallbackBounds
  private readonly visibility = { shown: true, offscreen: false, skipped: false, suspended: false }
  private readonly wakeTogether = (): void => {
    for (const part of this.parts) {
      // wakeUp changes state before dispatching its event. Recursive listeners therefore
      // visit only the remaining sleeping parts and stop without a per-frame wake loop.
      if (part.body.sleepState !== Body.AWAKE) {
        part.body.wakeUp()
      }
    }
  }
  private readonly struck = (event: { body: Body; contact: ContactEquation }): void => {
    // A partially settled corpse can have an awake hip but sleeping extremities. Cannon
    // emits no wakeup for that hip, so a new energetic contact must also wake its chain.
    if (
      event.body.mass > 0 &&
      Math.abs(event.contact.getImpactVelocityAlongNormal()) > 0.25 &&
      this.parts.some((part) => part.body.sleepState === Body.SLEEPING)
    ) {
      this.wakeTogether()
    }
  }

  constructor(
    world: World,
    rig: CorpseRig,
    motion: { velocity: Vector3; impulse: Vector3; impact?: RagdollImpact | null; step?: number },
    ground?: CorpseGround,
  ) {
    if (
      rig.links.length === 0 ||
      rig.links.some(
        (link) =>
          !(
            finite(link.position) &&
            finite(link.start) &&
            finite(link.end) &&
            Number.isFinite(link.radius) &&
            Number.isFinite(link.mass) &&
            [link.rotation.x, link.rotation.y, link.rotation.z, link.rotation.w].every(
              Number.isFinite,
            )
          ),
      )
    ) {
      throw new Error('Cannot simulate an invalid dressed skeleton')
    }
    this.world = world
    this.rig = rig
    // A newly attached rig starts its own support history, including a prepared/reused source.
    this.visibility.suspended = typeof rig.resetCloth === 'function'
    this.ground = ground
    this.parts = rig.links.map(makePart)
    this.poses = this.parts.map((part) => part.pose)
    const step = motion.step ?? RAGDOLL_STEP
    const velocity = motion.velocity.clone()
    limitCorpseVelocity(velocity)
    for (const [index, part] of this.parts.entries()) {
      tagCorpseBody(part.body, {
        owner: this,
        index,
        parent: part.link.parent,
        region: collisionGroup(part.link),
      })
      part.body.velocity.copy(xyz(velocity))
      // Cannon wakes only the struck rigid body. A sleeping neighbour would otherwise act
      // as a fixed anchor at the joint, suspending a corpse when another body hits it.
      part.body.addEventListener('wakeup', this.wakeTogether)
      part.body.addEventListener('collide', this.struck)
      world.addBody(part.body)
    }
    for (const child of this.parts) {
      const parent = this.parts[child.link.parent]
      if (parent) {
        const joint = corpseJoint(parent, child)
        // Cannon's default equations are tuned for1/60. Use our actual substep and stiffer
        // positional anchors so small per-joint errors do not accumulate down the real skin.
        for (const [index, equation] of joint.equations.entries()) {
          equation.setSpookParams(index < 3 ? 1e9 : 1e7, 4, step)
        }
        // Own broadphase excludes connected parts before Cannon's expensive global pair pass.
        if (world.broadphase instanceof CorpseBroadphase) {
          joint.collideConnected = true
        }
        world.addConstraint(joint)
        this.constraints.push(joint)
      }
    }
    this.impact(motion)
    this.sync(false)
  }

  private impact(motion: { impulse: Vector3; impact?: RagdollImpact | null }): void {
    const hit = motion.impact
    if (hit) {
      const point = new Vector3(hit.point.x, hit.point.y, hit.point.z)
      const direction = new Vector3(hit.direction.x, hit.direction.y, hit.direction.z)
      if (finite(point) && finite(direction) && direction.lengthSq() > 1e-8) {
        let nearest = this.parts[0]
        let distance = Number.POSITIVE_INFINITY
        for (const part of this.parts) {
          const segment = part.link.end.clone().sub(part.link.start)
          const t = Math.max(
            0,
            Math.min(
              1,
              point.clone().sub(part.link.start).dot(segment) / Math.max(1e-8, segment.lengthSq()),
            ),
          )
          const d = point.distanceToSquared(part.link.start.clone().addScaledVector(segment, t))
          if (d < distance) {
            nearest = part
            distance = d
          }
        }
        if (nearest) {
          const strength = hit.weapon === WEAPON_RIFLE || hit.weapon === WEAPON_SHOTGUN ? 4 : 2.5
          const p = nearest.body.position
          const arm = point.sub(new Vector3(p.x, p.y, p.z)).clampLength(0, 0.4)
          nearest.body.applyImpulse(xyz(direction.normalize().multiplyScalar(strength)), xyz(arm))
        }
        return
      }
    }
    const chest = this.parts.find((part) => part.link.key === 'Chest') ?? this.parts[0]
    if (chest && finite(motion.impulse)) {
      chest.body.applyImpulse(xyz(motion.impulse.clone().clampLength(0, 4)), new Vec3(0, 0.08, 0))
    }
  }

  /** Copy interpolated physics bone frames; the skin's authored child offsets never stretch. */
  sync(interpolate = true, view?: CorpseView): void {
    let floor = Number.POSITIVE_INFINITY
    for (const part of this.parts) {
      const p = interpolate ? part.body.interpolatedPosition : part.body.position
      const q = interpolate ? part.body.interpolatedQuaternion : part.body.quaternion
      part.pose.rotation.set(q.x, q.y, q.z, q.w)
      part.pose.position.copy(part.offset).applyQuaternion(part.pose.rotation)
      part.pose.position.x += p.x
      part.pose.position.y += p.y
      part.pose.position.z += p.z
      floor = Math.min(floor, p.y - part.link.radius)
    }
    this.rig.floor.value = floor
    if (this.rig.bounds) {
      this.worldBounds = this.rig.bounds(this.poses)
    } else {
      // Minimal physics fixtures have no skin. Real clones supply the measured geometry bound.
      const center = this.center()
      const radius = this.radius + 0.55
      this.worldBounds.makeEmpty().expandByPoint(center).expandByScalar(radius)
    }
    this.visibility.skipped = true
    if (view) {
      this.present(view)
    } else if (this.visible) {
      applyPose(this.rig, this.poses, this.ground, this.visibility)
    }
  }

  /** Recheck after the camera moves; newly visible and sleeping rigs pose before this draw. */
  present(view: CorpseView): void {
    setCorpseDetail(
      this.rig,
      view.position ? this.worldBounds.distanceToPoint(view.position) : 0,
      view.skipOffscreenPose,
    )
    this.visibility.offscreen =
      view.skipOffscreenPose && !view.frustum.intersectsBox(this.worldBounds)
    this.rig.root.visible = this.visible && !this.visibility.offscreen
    if (this.visible && !this.visibility.offscreen && this.visibility.skipped) {
      applyPose(this.rig, this.poses, this.ground, this.visibility)
    } else if (!this.visible || this.visibility.offscreen) {
      this.visibility.suspended = true
    }
  }

  /** A stable camera target follows the physical chest/pelvis, including a fall off a roof. */
  center(): Vector3 {
    this.focus.set(0, 0, 0)
    let mass = 0
    for (const part of this.parts) {
      const p = part.body.interpolatedPosition
      this.focus.x += p.x * part.body.mass
      this.focus.y += p.y * part.body.mass
      this.focus.z += p.z * part.body.mass
      mass += part.body.mass
    }
    return this.focus.multiplyScalar(1 / Math.max(0.1, mass))
  }

  get radius(): number {
    const center = this.center()
    let radius = 0
    for (const part of this.parts) {
      const position = part.body.interpolatedPosition
      radius = Math.max(
        radius,
        Math.hypot(position.x - center.x, position.y - center.y, position.z - center.z) +
          part.body.boundingRadius,
      )
    }
    return radius
  }

  get sleeping(): boolean {
    return this.parts.every((part) => part.body.sleepState === Body.SLEEPING)
  }

  get visible(): boolean {
    // A grounded blob can enter the lens while its body remains just outside it. Keep the
    // one instanced shadow draw independent of main-camera pose culling and obey explicit hide.
    return this.visibility.shown
  }

  setVisible(visible: boolean): void {
    this.visibility.shown = visible
    this.rig.root.visible = visible && !this.visibility.offscreen
    if (!visible) {
      this.visibility.suspended = true
    }
  }

  get poseActive(): boolean {
    return !this.visibility.skipped
  }

  /** Bound bad frame inputs/impulses before stepping the shared cosmetic world. */
  setStep(step: number): void {
    for (const joint of this.constraints) {
      for (const [index, equation] of joint.equations.entries()) {
        equation.setSpookParams(index < 3 ? 1e9 : 1e7, 4, step)
      }
    }
  }

  limitSpeed(): void {
    for (const { body } of this.parts) {
      limitCorpseVelocity(body.velocity, true)
      const spin = body.angularVelocity.length()
      if (!Number.isFinite(spin)) {
        body.angularVelocity.setZero()
      } else if (spin > 18) {
        body.angularVelocity.scale(18 / spin, body.angularVelocity)
      }
    }
  }

  get separation(): number {
    let error = 0
    for (const constraint of this.constraints) {
      if ('pivotA' in constraint && 'pivotB' in constraint) {
        const a = constraint.bodyA.pointToWorldFrame(constraint.pivotA as Vec3)
        const b = constraint.bodyB.pointToWorldFrame(constraint.pivotB as Vec3)
        error = Math.max(error, a.distanceTo(b))
      }
    }
    return error
  }

  dispose(): void {
    if (this.parts.length === 0) {
      return
    }
    for (const constraint of this.constraints) {
      this.world.removeConstraint(constraint)
    }
    for (const part of this.parts) {
      part.body.removeEventListener('wakeup', this.wakeTogether)
      part.body.removeEventListener('collide', this.struck)
      this.world.removeBody(part.body)
    }
    this.constraints.length = 0
    this.parts.length = 0
    this.rig.dispose()
  }
}
