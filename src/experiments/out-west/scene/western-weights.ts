/** Sleeve cuffs follow the real forearm; only the sewn cap blends back onto the torso. */
import { type Bone, type BufferGeometry, Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, boneKey, nearestWeights, onBones, type WeightFn } from './fit.ts'

interface Yoke {
  bone: Bone
  arm: Vector3
  center: number
  sign: number
}
const smooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

/** Spine for the trunk, graded clavicle influence over the actual sewn shoulder yoke. */
export function shirtTorsoWeights(body: Body): WeightFn {
  const names = ['Hips', 'Abdomen', 'Torso', 'Chest', 'Neck']
  const allowed = new Set(body.bones.filter((bone) => names.includes(boneKey(bone.name))))
  const nearest = nearestWeights(body, onBones(body, names))
  const frames = [...allowed].map((bone) => ({
    bone,
    position: bone.getWorldPosition(new Vector3()),
  }))
  const pelvis = frames.find(({ bone }) => boneKey(bone.name) === 'Hips')
  const yoke = yokeFrames(body)
  return (point) => {
    const weights = nearest(point).filter(([bone]) => allowed.has(bone))
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
    if (total > 1e-8) {
      return yokeBinding(
        point,
        tuckBinding(
          point,
          weights.map(([bone, weight]) => [bone, weight / total] as const),
          pelvis,
        ),
        yoke,
      )
    }
    let closest = frames[0]
    for (const frame of frames) {
      if (
        !closest ||
        frame.position.distanceToSquared(point) < closest.position.distanceToSquared(point)
      ) {
        closest = frame
      }
    }
    return yokeBinding(point, tuckBinding(point, closest ? [[closest.bone, 1]] : [], pelvis), yoke)
  }
}

/** Only the tucked waist shares the strap's pelvis anchor; the upper trunk keeps its authored blend. */
function tuckBinding(
  point: Vector3,
  trunk: ReturnType<WeightFn>,
  pelvis: { bone: Bone; position: Vector3 } | undefined,
): ReturnType<WeightFn> {
  if (!pelvis) {
    return trunk
  }
  const amount = 1 - smooth((point.y - pelvis.position.y - 0.07) / 0.07)
  if (amount === 0) {
    return trunk
  }
  let hip = amount
  const rest: (readonly [Bone, number])[] = []
  for (const [bone, weight] of trunk) {
    if (bone === pelvis.bone) {
      hip += weight * (1 - amount)
    } else {
      rest.push([bone, weight * (1 - amount)])
    }
  }
  return [[pelvis.bone, hip], ...rest]
}

function yokeFrames(body: Body): Yoke[] {
  const bone = (name: string) => body.bones.find((item) => boneKey(item.name) === name)
  const center = bone('Hips')?.getWorldPosition(new Vector3()).x ?? 0
  return (['L', 'R'] as const).flatMap((side) => {
    const shoulder = bone(`Shoulder${side}`)
    const arm = bone(`UpperArm${side}`)?.getWorldPosition(new Vector3())
    return shoulder && arm ? [{ bone: shoulder, arm, center, sign: Math.sign(arm.x - center) }] : []
  })
}
function yokeBinding(
  point: Vector3,
  trunk: ReturnType<WeightFn>,
  frames: Yoke[],
): ReturnType<WeightFn> {
  const frame = frames.find((item) => (point.x - item.center) * item.sign >= 0)
  if (!frame) {
    return trunk
  }
  const width = Math.abs(frame.arm.x - frame.center)
  const lateral = (point.x - frame.center) * frame.sign
  const across = smooth((lateral - width * 0.35) / (width * 0.55))
  const band = 1 - smooth((Math.abs(point.y - frame.arm.y) - 0.1) / 0.15)
  const amount = across * band * 0.94
  return [
    ...trunk.map(([bone, weight]) => [bone, weight * (1 - amount)] as const),
    [frame.bone, amount],
  ]
}

export function sleeveWeights(body: Body, authoredSide?: 'L' | 'R'): WeightFn {
  const bone = (key: string) => body.bones.find((candidate) => boneKey(candidate.name) === key)
  const torso = shirtTorsoWeights(body)
  const arms = (['L', 'R'] as const).flatMap((side) => {
    const upper = bone(`UpperArm${side}`)
    const lower = bone(`LowerArm${side}`)
    const wrist = bone(`Wrist${side}`)
    if (!(upper && lower && wrist)) {
      return []
    }
    return [
      {
        side,
        upper,
        lower,
        start: upper.getWorldPosition(new Vector3()),
        elbow: lower.getWorldPosition(new Vector3()),
        end: wrist.getWorldPosition(new Vector3()),
      },
    ]
  })
  return (p) => {
    const arm = arms.find(
      (candidate) => candidate.side === (authoredSide ?? (p.x >= 0 ? 'L' : 'R')),
    )
    if (!arm) {
      return torso(p)
    }
    const forearm = arm.end.clone().sub(arm.elbow)
    const along = p.clone().sub(arm.elbow).dot(forearm) / forearm.lengthSq()
    const lower = Math.max(0, Math.min(1, (along + 0.1) / 0.3))
    const humerus = arm.elbow.clone().sub(arm.start)
    const proximal = p.clone().sub(arm.start).dot(humerus) / humerus.lengthSq()
    const blend = Math.max(0, Math.min(1, (proximal - 0.02) / 0.3))
    const cap = blend * blend * (3 - 2 * blend)
    if (cap < 1 && along < 0) {
      return [...torso(p).map(([b, w]) => [b, w * (1 - cap)] as const), [arm.upper, cap]]
    }
    return [
      [arm.upper, 1 - lower],
      [arm.lower, lower],
    ]
  }
}

/** The armhole belongs to both pieces: it retains one exact position, normal and skin binding. */
export function shirtSkin(
  geometry: BufferGeometry,
  body: Body,
  binding: { torso: WeightFn; rings: ReadonlyMap<number, ReturnType<WeightFn>> },
): NonNullable<Piece['skin']> {
  const originals = geometry.userData.sourceVertices as number[]
  const position = geometry.getAttribute('position')
  const indices = new Map(body.bones.map((bone, index) => [bone, index]))
  const point = new Vector3()
  const skin = {
    index: new Uint16Array(position.count * 4),
    weight: new Float32Array(position.count * 4),
  }
  for (let vertex = 0; vertex < position.count; vertex++) {
    point.fromBufferAttribute(position, vertex)
    const weights = [...(binding.rings.get(originals[vertex] ?? -1) ?? binding.torso(point))]
      .map(([bone, weight]) => [indices.get(bone) ?? 0, weight] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0) || 1
    for (const [slot, [bone, weight]] of weights.entries()) {
      skin.index[vertex * 4 + slot] = bone
      skin.weight[vertex * 4 + slot] = weight / total
    }
  }
  return skin
}
