/**
 * A duellist's small habits, layered on his idle and walk clips (the UAL set has no fidgets, no
 * hat tip and no gesturing walk): one-shot beats (a glance, a weight shift, a shoulder roll, the
 * hat tip after a win, a look down at a new coat in the Outfitter, a thumb over the hammer at the
 * cock) and two held layers (the talker's hand working as he walks, and the standoff's gun hand
 * hovering over the leather). Fidgets come on his own random clock: nothing here reads the call.
 *
 * Every turn is about a WORLD axis (his pitch axis, his forward, straight up) carried into the
 * bone's parent space, as scene/folk-pose.ts does, so it never depends on how a bone was rigged.
 * `undo` puts back what `apply` turned before the next mixer pass. The draw layer (scene/draw.ts)
 * runs after this one and owns the arms while it is active; the layer fades out under it.
 */
import { type Bone, MathUtils, type Object3D, Quaternion, Vector3 } from 'three'
import { solveArm } from './longgun.ts'

export type Beat = 'glance' | 'shift' | 'roll' | 'tipHat' | 'admire' | 'thumb' | 'flinch'

/** Where his fidgets come from: the hub's variety idles, the standoff's nerves, or none. */
export type Fidget = 'hub' | 'standoff' | null

const SECS: Record<Beat, number> = {
  glance: 1.9,
  shift: 2.6,
  roll: 1.5,
  tipHat: 1.5,
  admire: 2.4,
  thumb: 1.1,
  flinch: 0.55,
}
/** Body-only beats that play even under the draw (it owns the arms, not the spine and head). */
const BODY_ONLY: ReadonlySet<Beat> = new Set<Beat>(['flinch'])

/** Which beats each fidget mode picks from (the hub greets now and then; the standoff never). */
const POOL: Record<'hub' | 'standoff', readonly Beat[]> = {
  hub: ['glance', 'shift', 'roll', 'glance', 'shift', 'tipHat'],
  standoff: ['glance', 'roll', 'thumb', 'shift'],
}
/** Seconds between fidgets (min, spread). */
const GAP: Record<'hub' | 'standoff', [number, number]> = { hub: [3.5, 4.5], standoff: [2.2, 3] }

const UP = new Vector3(0, 1, 0)
const smooth = (x: number): number => {
  const v = MathUtils.clamp(x, 0, 1)
  return v * v * (3 - 2 * v)
}
/** In over the first `a` of the beat, held, out over the last `b`. */
const envelope = (u: number, a: number, b: number): number =>
  Math.min(smooth(u / a), smooth((1 - u) / b))

interface Bones {
  hips: Bone | null
  spine: Bone | null
  chest: Bone | null
  neck: Bone | null
  head: Bone | null
  upper: [Bone | null, Bone | null]
  lower: [Bone | null, Bone | null]
  wrist: [Bone | null, Bone | null]
  /** The strong hand's finger joints: opened flat in the ready stance. */
  fingers: Bone[]
}

/** The strong hand's joints, from the knuckle to the fingertip (the rig's names). */
const FINGER_NAMES = ['Index', 'Middle', 'Ring', 'Pinky']
  .flatMap((f) => [1, 2, 3, 4].map((j) => `${f}${j}R`))
  .concat(['Thumb1R', 'Thumb2R', 'Thumb3R'])

const pq = new Quaternion()
const tq = new Quaternion()
const sp = new Vector3()
const ss = new Vector3()
const ax = new Vector3()
const pitchAxis = new Vector3()
const hp = new Vector3()
const wp = new Vector3()
const tp = new Vector3()
const pole = new Vector3()
const wq = new Quaternion()
const fwdAxis = new Vector3()

/** Turn `b` by `a` (rad) about world axis `axis`, in its parent's space. */
function turn(b: Bone | null, axis: Vector3, a: number): void {
  if (!b || Math.abs(a) < 1e-4) {
    return
  }
  const parent = b.parent
  ax.copy(axis)
  if (parent) {
    parent.matrixWorld.decompose(sp, pq, ss)
    ax.applyQuaternion(pq.invert())
  }
  b.quaternion.premultiply(tq.setFromAxisAngle(ax, a))
}

export class GestureLayer {
  /** The talker's working hand while he walks (target weight 0..1). */
  talk = 0
  /** The gun hand hovering over the holster through the standoff (target weight 0..1). */
  hover = 0
  /** His fidget habit (null: none). */
  fidget: Fidget = null
  private wTalk = 0
  private wHover = 0
  /** Fades the whole layer under the draw, a hit or a death. */
  private wAll = 1
  private beat: Beat | null = null
  private side = 1
  private bt = 0
  private nextIn = 2 + Math.random() * 3
  private t = Math.random() * 10
  private readonly root: Object3D
  private readonly b: Bones
  private readonly list: Bone[]
  private readonly saved: Quaternion[]
  /** The Idle-clip finger pose: the open hand the ready stance returns to. */
  private readonly restFingers: Quaternion[]
  private applied: boolean = false as boolean

  constructor(bone: (n: string) => Bone | null, root: Object3D) {
    this.root = root
    this.b = {
      hips: bone('Hips'),
      spine: bone('Abdomen') ?? bone('Torso'),
      chest: bone('Chest'),
      neck: bone('Neck'),
      head: bone('Head'),
      upper: [bone('UpperArmL'), bone('UpperArmR')],
      lower: [bone('LowerArmL'), bone('LowerArmR')],
      wrist: [bone('WristL') ?? bone('FistL'), bone('WristR') ?? bone('FistR')],
      fingers: FINGER_NAMES.map((n) => bone(n)).filter((x): x is Bone => x !== null),
    }
    const b = this.b
    this.list = [
      b.hips,
      b.spine,
      b.chest,
      b.neck,
      b.head,
      ...b.upper,
      ...b.lower,
      ...b.wrist,
      ...b.fingers,
    ].filter((x): x is Bone => x !== null)
    this.saved = this.list.map(() => new Quaternion())
    this.restFingers = b.fingers.map((f) => f.quaternion.clone())
  }

  /** Play a beat now (it replaces one under way). */
  play(beat: Beat, side = Math.random() < 0.5 ? 1 : -1): void {
    this.beat = beat
    this.bt = 0
    this.side = side
  }

  /** Drop everything at once: no beat, no held layer, no fidgets (a new duel, a new phase). */
  clear(): void {
    this.beat = null
    this.talk = 0
    this.hover = 0
    this.fidget = null
    this.wTalk = 0
    this.wHover = 0
  }

  /** The beat under way, for the dev probe. */
  get current(): Beat | null {
    return this.beat
  }

  /** Anything posing him this frame, for the dev probe: the beat and held layers by weight. */
  get weight(): number {
    const body = this.beat && BODY_ONLY.has(this.beat) ? 1 : 0
    return Math.max(body, this.wAll * Math.max(this.beat ? 1 : 0, this.wTalk, this.wHover))
  }

  undo(): void {
    if (!this.applied) {
      return
    }
    for (const [i, b] of this.list.entries()) {
      const q = this.saved[i]
      if (q) {
        b.quaternion.copy(q)
      }
    }
    this.applied = false
  }

  /** After the mixer: advance by `dt` and layer the pose; `held` while the draw or a clip owns him. */
  apply(dt: number, held: boolean): void {
    this.t += dt
    const k = 1 - Math.exp(-dt * 6)
    this.wTalk += (this.talk - this.wTalk) * k
    this.wHover += (this.hover - this.wHover) * k
    this.wAll += ((held ? 0 : 1) - this.wAll) * (1 - Math.exp(-dt * (held ? 18 : 4)))
    this.tickBeat(dt, held)
    if (this.weight < 0.002) {
      return
    }
    for (const [i, b] of this.list.entries()) {
      this.saved[i]?.copy(b.quaternion)
    }
    this.applied = true
    const yaw = this.root.getWorldQuaternion(pq)
    fwdAxis.set(0, 0, 1).applyQuaternion(yaw)
    fwdAxis.y = 0
    fwdAxis.normalize()
    // swinging a hanging limb forward is a positive turn about this
    pitchAxis.crossVectors(fwdAxis, UP).normalize()
    // parents first: each turn reads its parent's last world matrix
    this.root.updateMatrixWorld(true)
    this.pose()
  }

  private tickBeat(dt: number, held: boolean): void {
    if (this.beat && held && !BODY_ONLY.has(this.beat) && this.wAll < 0.05) {
      this.beat = null
    }
    if (this.beat) {
      this.bt += dt
      if (this.bt >= SECS[this.beat]) {
        this.beat = null
      }
      return
    }
    if (!this.fidget || held) {
      return
    }
    this.nextIn -= dt
    if (this.nextIn <= 0) {
      const pool = POOL[this.fidget]
      const gap = GAP[this.fidget]
      this.nextIn = gap[0] + Math.random() * gap[1]
      this.play(pool[Math.floor(Math.random() * pool.length)] ?? 'glance')
    }
  }

  /** Layer the beat and the held layers, all scaled by the overall weight. */
  private pose(): void {
    const b = this.b
    const w = this.wAll
    const P = pitchAxis
    const F = fwdAxis
    // held: the talker's left hand working, palm up, as he talks over his shoulder
    const tk = this.wTalk * w
    if (tk > 0.002) {
      const s = Math.sin(this.t * 3.1)
      turn(b.upper[0], P, tk * (0.55 + 0.22 * s))
      turn(b.upper[0], F, tk * 0.28)
      turn(b.lower[0], P, tk * (1.05 + 0.35 * Math.sin(this.t * 3.1 + 0.7)))
      turn(b.neck, UP, tk * 0.32 * Math.sin(this.t * 0.8))
      turn(b.head, UP, tk * 0.38 * Math.sin(this.t * 0.8))
      turn(b.head, P, -tk * 0.06 * (1 + s))
    }
    // held: the gun hand out from the hip, fingers over the grip, a tremor; shoulders hunched
    const hv = this.wHover * w
    if (hv > 0.002) {
      const tremor = Math.sin(this.t * 21) * 0.025 + Math.sin(this.t * 13.7) * 0.015
      turn(b.upper[1], F, -hv * (0.24 + tremor))
      turn(b.upper[1], P, hv * 0.12)
      turn(b.lower[1], P, hv * (0.42 + tremor))
      turn(b.upper[0], F, hv * 0.1)
      turn(b.chest, P, hv * 0.06)
      turn(b.head, P, -hv * 0.08)
      // a quick-draw hand is open, not a fist: let the walk clip's fingers out flat
      for (const [i, f] of b.fingers.entries()) {
        const rest = this.restFingers[i]
        if (rest) {
          f.quaternion.slerp(rest, hv)
        }
      }
    }
    if (this.beat) {
      this.poseBeat(this.beat, this.bt / SECS[this.beat], BODY_ONLY.has(this.beat) ? 1 : w)
    }
  }

  /**
   * Two-bone IK (scene/longgun.ts): carry hand `i` (0 left, 1 right) from where the clip has it
   * toward `spot(head)` by `k`, the elbow out and down, the wrist as the clip turned it.
   */
  private reach(i: 0 | 1, k: number, spot: (head: Vector3, out: Vector3) => Vector3): void {
    const upper = this.b.upper[i]
    const lower = this.b.lower[i]
    const end = this.b.wrist[i]
    const head = this.b.head
    if (!(upper && lower && end && head) || k < 0.002) {
      return
    }
    const side = i === 1 ? 1 : -1
    head.getWorldPosition(hp)
    const hand = end.getWorldPosition(wp)
    spot(hp, tp)
    hand.lerp(tp, k)
    end.getWorldQuaternion(wq)
    upper
      .getWorldPosition(pole)
      .addScaledVector(pitchAxis, side * 0.5)
      .addScaledVector(UP, -0.35)
    solveArm({ upper, lower, end }, hand, wq, pole)
  }

  private poseBeat(beat: Beat, u: number, w: number): void {
    const b = this.b
    const P = pitchAxis
    const F = fwdAxis
    const s = this.side
    switch (beat) {
      case 'glance': {
        // a look down the street and back
        const e = envelope(u, 0.25, 0.3) * w
        turn(b.neck, UP, s * 0.42 * e)
        turn(b.head, UP, s * 0.55 * e)
        turn(b.chest, UP, s * 0.12 * e)
        break
      }
      case 'shift': {
        // his weight onto one leg: hips drop to a side, the spine answers
        const e = envelope(u, 0.3, 0.35) * w
        turn(b.hips, F, s * 0.1 * e)
        turn(b.spine, F, -s * 0.14 * e)
        turn(b.head, F, s * 0.06 * e)
        turn(b.upper[0], F, 0.06 * e)
        turn(b.upper[1], F, -0.06 * e)
        break
      }
      case 'roll': {
        // the neck stretched one way, the shoulders rolled
        const e = Math.sin(Math.PI * MathUtils.clamp(u, 0, 1)) * w
        turn(b.head, F, s * 0.34 * e)
        turn(b.neck, F, s * 0.14 * e)
        turn(b.chest, P, -0.08 * e)
        turn(b.upper[0], F, 0.12 * e)
        turn(b.upper[1], F, -0.12 * e)
        break
      }
      case 'tipHat': {
        // the right hand up to the brim, a nod, and down
        const e = envelope(u, 0.32, 0.36) * w
        const nod = Math.sin(Math.PI * MathUtils.clamp((u - 0.25) / 0.5, 0, 1)) * w
        this.reach(1, e, (head, out) =>
          out
            .copy(head)
            .addScaledVector(F, 0.15)
            .addScaledVector(UP, 0.17)
            .addScaledVector(P, 0.07),
        )
        turn(b.head, P, -0.3 * nod)
        turn(b.chest, P, -0.06 * nod)
        break
      }
      case 'admire': {
        // a look down at the new kit, arms out a little, a turn one way and the other
        const e = envelope(u, 0.2, 0.25) * w
        turn(b.head, P, -0.5 * e)
        turn(b.neck, P, -0.2 * e)
        turn(b.chest, UP, 0.32 * Math.sin(Math.PI * 2 * u) * e)
        turn(b.upper[0], F, 0.38 * e)
        turn(b.upper[1], F, -0.38 * e)
        turn(b.lower[0], P, 0.55 * e)
        turn(b.lower[1], P, 0.55 * e)
        break
      }
      case 'thumb': {
        // the gun hand to the hammer and away (the cock; a standoff fidget)
        const e = envelope(u, 0.3, 0.4) * w
        turn(b.upper[1], F, -0.2 * e)
        turn(b.upper[1], P, 0.22 * e)
        turn(b.lower[1], P, 0.7 * e)
        turn(b.head, P, -0.18 * e)
        turn(b.head, UP, -0.15 * e)
        break
      }
      case 'flinch': {
        // a near miss: the head snaps aside and down, the shoulders hunch, and he steadies
        const e = Math.min(smooth(u / 0.12), smooth((1 - u) / 0.7)) * w
        turn(b.head, UP, s * 0.35 * e)
        turn(b.head, F, s * 0.18 * e)
        turn(b.neck, P, -0.2 * e)
        turn(b.chest, P, -0.16 * e)
        turn(b.spine, F, -s * 0.08 * e)
        break
      }
      default:
        break
    }
  }
}
