/**
 * Procedural poses for the townsfolk, layered on their idle clip each frame: sitting on a bench,
 * whittling, leaning on a post or a balcony rail, flinching, cowering with the arms over the
 * head, ducking, and turning the head to watch something. The clips have no sit or cower, and
 * these never need to be exact: a man on a porch twenty metres off.
 *
 * Every turn is about a WORLD axis (the man's own pitch axis, or straight up), applied to the
 * bone in its parent's space, so it never depends on how each bone's local axes were rigged.
 * The parent-space axes are cached and refreshed from the last rendered frame now and then.
 */
import type { Bone, Object3D } from 'three'
import { Quaternion, Vector3 } from 'three'

/** How far into each pose he is (all blend smoothly; 0 = standing at his idle). */
export interface PoseMix {
  /** Seated on a bench (0..1). */
  sit: number
  /** Knife and stick in his lap (0..1, while sitting). */
  whittle: number
  /** Knees bent, rad (a flinch is ~0.3, a duck ~1.1). */
  crouch: number
  /** Torso bent forward, rad. */
  bend: number
  /** Arms up over the head (0..1). */
  cover: number
  /** Forearms forward onto a rail (0..1). */
  rail: number
  /** Shoulder against a post (signed roll, rad). */
  lean: number
  /** Head turn toward what he's watching, rad (+ = to his left). */
  look: number
  /** Head tilt down, rad. */
  nod: number
}

export const restMix = (): PoseMix => ({
  sit: 0,
  whittle: 0,
  crouch: 0,
  bend: 0,
  cover: 0,
  rail: 0,
  lean: 0,
  look: 0,
  nod: 0,
})

/** Move `m` toward `to` at `rate` per second (exponential, frame-rate independent). */
export function blendMix(m: PoseMix, to: PoseMix, rate: number, dt: number): void {
  const k = 1 - Math.exp(-rate * dt)
  for (const key of Object.keys(m) as (keyof PoseMix)[]) {
    m[key] += (to[key] - m[key]) * k
  }
}

export interface FolkBones {
  hips: Bone | null
  spine: Bone | null
  chest: Bone | null
  neck: Bone | null
  head: Bone | null
  upperArm: [Bone | null, Bone | null]
  lowerArm: [Bone | null, Bone | null]
  upperLeg: [Bone | null, Bone | null]
  lowerLeg: [Bone | null, Bone | null]
  foot: [Bone | null, Bone | null]
}

/** Find his bones by the shared skeleton's names. */
export function folkBones(model: Object3D): FolkBones {
  const byName = new Map<string, Bone>()
  model.traverse((o) => {
    if ((o as Partial<Bone>).isBone === true) {
      byName.set(o.name, o as Bone)
    }
  })
  const b = (n: string) => byName.get(n) ?? null
  return {
    hips: b('Hips'),
    spine: b('Abdomen') ?? b('Torso'),
    chest: b('Chest'),
    neck: b('Neck'),
    head: b('Head'),
    upperArm: [b('UpperArmL'), b('UpperArmR')],
    lowerArm: [b('LowerArmL'), b('LowerArmR')],
    upperLeg: [b('UpperLegL'), b('UpperLegR')],
    lowerLeg: [b('LowerLegL'), b('LowerLegR')],
    foot: [b('FootL'), b('FootR')],
  }
}

/** Every bone a pose turns, once each. */
function touched(bones: FolkBones): Bone[] {
  const all = [
    bones.hips,
    bones.spine,
    bones.chest,
    bones.neck,
    bones.head,
    ...bones.upperArm,
    ...bones.lowerArm,
    ...bones.upperLeg,
    ...bones.lowerLeg,
    ...bones.foot,
  ]
  return all.filter((x): x is Bone => x !== null)
}

/**
 * The pose layer of one man: `undo` puts back what the last `apply` turned (before his mixer
 * runs, so a bone no clip keys never accumulates turns), `apply` layers the pose on the clip.
 */
export class FolkPose {
  private readonly bones: FolkBones
  private readonly list: Bone[]
  private readonly saved: Quaternion[]
  private applied: boolean = false as boolean

  constructor(model: Object3D) {
    this.bones = folkBones(model)
    this.list = touched(this.bones)
    this.saved = this.list.map(() => new Quaternion())
  }

  undo(): void {
    if (!this.applied) {
      return
    }
    this.list.forEach((b, i) => {
      b.quaternion.copy(this.saved[i] ?? b.quaternion)
    })
    this.applied = false
  }

  /**
   * Layer `m` (see applyPose). `refresh` re-reads the turn axes from the last rendered matrices
   * (every few tenths of a second, or every frame while the pose is changing fast).
   */
  apply(m: PoseMix, yaw: number, t: number, refresh: boolean): number {
    this.list.forEach((b, i) => {
      this.saved[i]?.copy(b.quaternion)
    })
    this.applied = true
    refreshing = refresh
    const drop = applyPose(this.bones, m, yaw, t)
    refreshing = false
    return drop
  }
}

const UP = new Vector3(0, 1, 0)
const pq = new Quaternion()
const tq = new Quaternion()
const sp = new Vector3()
const ss = new Vector3()

/**
 * Each bone's turn axes in its parent's space (pitch, up, forward), refreshed now and then from
 * the last rendered frame's matrices: no per-frame world-matrix walks (CPU on the floor device).
 */
const axes = new WeakMap<Bone, [Vector3, Vector3, Vector3]>()
let refreshing = false

/** Turn `b` by `a` about world axis `axis` (slot `k`: 0 pitch, 1 up, 2 forward). */
function turn(b: Bone | null, k: 0 | 1 | 2, axis: Vector3, a: number): void {
  if (!b || Math.abs(a) < 1e-4) {
    return
  }
  let slot = axes.get(b)
  if (!slot) {
    slot = [new Vector3(), new Vector3(), new Vector3()]
    axes.set(b, slot)
    refreshing = true
  }
  const ax = slot[k]
  if (refreshing) {
    const parent = b.parent
    if (parent) {
      parent.matrixWorld.decompose(sp, pq, ss)
      ax.copy(axis).applyQuaternion(pq.invert())
    } else {
      ax.copy(axis)
    }
  }
  b.quaternion.premultiply(tq.setFromAxisAngle(ax, a))
}

const pitch = new Vector3()
const forward = new Vector3()

/**
 * Layer `m` on the clip's pose. `yaw` is the way he faces; `t` his own clock (for the knife).
 * Returns how far his hips drop (m), for the caller to lower his root.
 */
function applyPose(bones: FolkBones, m: PoseMix, yaw: number, t: number): number {
  forward.set(Math.sin(yaw), 0, Math.cos(yaw))
  // swinging a hanging limb forward is a positive turn about this; bending a rising one, negative
  pitch.crossVectors(forward, UP).normalize()
  const knee = m.crouch * (1 - m.sit)
  for (let i = 0; i < 2; i++) {
    turn(bones.upperLeg[i] ?? null, 0, pitch, m.sit * 1.5 + knee)
    turn(bones.lowerLeg[i] ?? null, 0, pitch, -m.sit * 1.45 - knee * 2)
    turn(bones.foot[i] ?? null, 0, pitch, knee * 0.9)
  }
  turn(bones.hips, 2, forward, m.lean * 0.4)
  turn(bones.spine, 0, pitch, -(m.bend * 0.6 + m.whittle * 0.15))
  turn(bones.chest, 0, pitch, -m.bend * 0.4)
  turn(bones.spine, 2, forward, m.lean * 0.6)
  const stroke = Math.sin(t * 5.2) * 0.18 * m.whittle
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1
    const upper = bones.upperArm[i] ?? null
    const lower = bones.lowerArm[i] ?? null
    // over the head: the upper arm up past level, the forearm folded back over the crown
    turn(upper, 0, pitch, m.cover * 2.5 + m.rail * 0.4 + m.whittle * 0.3)
    turn(upper, 1, UP, side * (m.cover * 0.5 + m.whittle * 0.25))
    turn(lower, 0, pitch, m.cover * 1.2 + m.rail * 0.55 + m.whittle * 0.3 + (i === 1 ? stroke : 0))
  }
  turn(bones.neck, 1, UP, m.look * 0.45)
  turn(bones.head, 1, UP, m.look * 0.55)
  turn(bones.head, 0, pitch, -(m.nod + m.cover * 0.35 + m.whittle * 0.45))
  // two shin-and-thigh lengths (~0.44 m each) shorten by 1 - cos of the bend
  return 0.88 * (1 - Math.cos(knee))
}
