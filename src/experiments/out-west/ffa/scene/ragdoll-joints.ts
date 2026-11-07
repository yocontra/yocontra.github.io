/** Anatomical joint limits in the rigid bodies' local frames. No rendering or sim authority. */
import {
  type Body,
  ConeTwistConstraint,
  HingeConstraint,
  RotationalEquation,
  Vec3,
} from 'cannon-es'
import { Quaternion, Vector3 } from 'three'
import type { CorpseBone, CorpseLink } from './crowd/corpse-rig.ts'

const RAD = Math.PI / 180
export const RAGDOLL_STEP = 1 / 120
const LIMITS: Record<CorpseBone, readonly [number, number]> = {
  Hips: [0, 0],
  Abdomen: [12, 12],
  Torso: [12, 12],
  Chest: [10, 10],
  Neck: [25, 20],
  Head: [30, 25],
  UpperArmL: [95, 65],
  UpperArmR: [95, 65],
  LowerArmL: [155, 0],
  LowerArmR: [155, 0],
  WristL: [45, 45],
  WristR: [45, 45],
  UpperLegL: [70, 35],
  UpperLegR: [70, 35],
  LowerLegL: [145, 0],
  LowerLegR: [145, 0],
  FootL: [35, 20],
  FootR: [35, 20],
}

const cv = (v: Vector3): Vec3 => new Vec3(v.x, v.y, v.z)
const direction = (link: CorpseLink): Vector3 => link.end.clone().sub(link.start).normalize()
const restDirection = (link: CorpseLink): Vector3 =>
  link.restPosition && link.restEnd
    ? link.restEnd.clone().sub(link.restPosition).normalize()
    : direction(link)
const restLocal = (link: CorpseLink, world: Vector3): Vec3 =>
  cv(world.clone().applyQuaternion((link.restRotation ?? link.rotation).clone().invert()))

/** A real solver equation limits the hinge to [0,max] flexion; it cannot hyperextend. */
class LimitedHinge extends HingeConstraint {
  private readonly limit: RotationalEquation
  private readonly referenceA: Vec3
  private readonly referenceB: Vec3

  constructor(
    a: Body,
    b: Body,
    options: {
      pivot: Vec3
      axisA: Vec3
      axisB: Vec3
      referenceA: Vec3
      referenceB: Vec3
      maximum: number
    },
  ) {
    super(a, b, {
      pivotA: a.pointToLocalFrame(options.pivot),
      pivotB: b.pointToLocalFrame(options.pivot),
      axisA: options.axisA,
      axisB: options.axisB,
      maxForce: 50_000,
      collideConnected: false,
    })
    this.referenceA = options.referenceA
    this.referenceB = options.referenceB
    this.limit = new RotationalEquation(a, b, { maxForce: 50_000 })
    this.limit.maxAngle = options.maximum / 2
    this.limit.minForce = -50_000
    this.limit.maxForce = 0
    this.equations.push(this.limit)
  }

  override update(): void {
    super.update()
    this.bodyA.vectorToWorldFrame(this.referenceA, this.limit.axisA)
    this.bodyB.vectorToWorldFrame(this.referenceB, this.limit.axisB)
  }
}

export function corpseJoint(
  parent: { body: Body; link: CorpseLink },
  child: { body: Body; link: CorpseLink },
) {
  const { body: a, link: p } = parent
  const { body: b, link: c } = child
  const limit = LIMITS[c.key]
  const pivot = cv(c.start)
  const pd = restDirection(p)
  const cd = restDirection(c)
  if (
    c.key === 'LowerArmL' ||
    c.key === 'LowerArmR' ||
    c.key === 'LowerLegL' ||
    c.key === 'LowerLegR'
  ) {
    const forward = (c.forward ?? p.forward ?? new Vector3(0, 0, 1)).clone()
    const leg = c.key === 'LowerLegL' || c.key === 'LowerLegR'
    const axis = new Vector3().crossVectors(pd, forward.multiplyScalar(leg ? -1 : 1))
    if (axis.lengthSq() < 1e-5) {
      // Straight limbs still get a definite anatomical hinge, never a free ball joint.
      axis.set(1, 0, 0).applyQuaternion(p.restRotation ?? p.rotation)
      axis.addScaledVector(pd, -axis.dot(pd))
      if (axis.lengthSq() < 1e-5) {
        axis.set(0, 0, 1).cross(pd)
      }
    }
    axis.normalize()
    const maximum = limit[0] * RAD
    const middle = pd.clone().applyQuaternion(new Quaternion().setFromAxisAngle(axis, maximum / 2))
    return new LimitedHinge(a, b, {
      pivot,
      axisA: restLocal(p, axis),
      axisB: restLocal(c, axis),
      referenceA: restLocal(p, middle),
      referenceB: restLocal(c, cd),
      maximum,
    })
  }
  // The rest-pose axis is expressed separately in each local body frame. A shoulder's
  // different bind orientation therefore does not create an initial corrective impulse.
  const axis = cv(cd)
  const joint = new ConeTwistConstraint(a, b, {
    pivotA: a.pointToLocalFrame(pivot),
    pivotB: b.pointToLocalFrame(pivot),
    axisA: restLocal(p, cd),
    axisB: restLocal(c, cd),
    angle: limit[0] * RAD,
    twistAngle: limit[1] * RAD,
    maxForce: 50_000,
    collideConnected: false,
  })
  const tangent = new Vec3()
  const other = new Vec3()
  axis.tangents(tangent, other)
  // Cannon's tangents are perpendicular cross products, not unit vectors. Its rotational
  // equation compares their raw dot product with cos(maxAngle), so an oblique ankle axis
  // otherwise creates an impossible twist error even in the neutral pose.
  tangent.normalize()
  const worldTangent = new Vector3(tangent.x, tangent.y, tangent.z)
  const referenceA = restLocal(p, worldTangent)
  const referenceB = restLocal(c, worldTangent)
  const update = joint.update.bind(joint)
  joint.update = () => {
    update()
    a.vectorToWorldFrame(referenceA, joint.twistEquation.axisA)
    b.vectorToWorldFrame(referenceB, joint.twistEquation.axisB)
  }
  return joint
}
