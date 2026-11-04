/**
 * The quick-draw and turn, layered over the clips with bone overrides (as scene/longgun.ts solves
 * two-hand aim). Presentation only: nothing here gates or delays a shot; `fire()` takes the gun out
 * NOW, wherever the draw has got to, and the timeline catches up.
 *
 * One draw, normalised to `u` 0..1 over his draw time:
 * - the turn: the root pivots on the spot (the feet stay planted by leg IK) while his hips lead,
 *   his shoulders follow and his head leads both; he sinks a little into the turn;
 * - the gun hand: from the clip's hanging hand down onto the grip in the holster (`U_GRIP`, where
 *   the gun changes hands with no pop: the hand meets it exactly where it sits), the pull straight
 *   up out of the leather, the barrel coming level at the hip (`U_HIP`: a shot before here jumps
 *   to it, the hip shot) and on up into the clip's aim, turned onto his man, with a small
 *   overshoot that settles;
 * - the off hand: the second gun mirrors the first (two-gun men), or it comes over to steady the
 *   grip as the clip has it, or palm-down over the hammer to fan.
 * A flinch (the fake-out) is a partial draw that re-holsters; the spin is the gun twirled on the
 * trigger finger and dropped back in the holster after a win.
 */
import { type Bone, MathUtils, Quaternion, Vector3 } from 'three'
import {
  type Armed,
  ease,
  type HandState,
  handStates,
  offHandTarget,
  seatGun,
  smooth,
  toHand,
  toHolster,
  UP,
} from './draw-hands.ts'
import {
  aimCorrection,
  alongKeys,
  copyPose,
  type GunPose,
  gunInHand,
  gunPose,
  holstered,
  levelPose,
  moveWorld,
  pitch,
  pulled,
  rotateWorld,
  swingAbout,
  worldOf,
  wristFor,
} from './draw-pose.ts'
import type { GunAnatomy } from './holster.ts'
import { solveArm } from './longgun.ts'

export type OffHand = 'steady' | 'fan'

export interface DrawSpec {
  /** Seconds from the start to the aim. */
  secs: number
  /** Root yaw to turn through (null: he already faces his man). */
  turn: { from: number; to: number } | null
  /** Where he aims (world), or null for straight ahead. */
  target: () => Vector3 | null
  /** The single-gun off hand's habit. */
  off?: OffHand
  /** A road-agent spin of the gun(s) on the way up (the boss). */
  flourish?: boolean
}

type Mode = 'off' | 'draw' | 'flinch' | 'spin'

const U_GRIP = 0.26
const U_TURN = 0.78
/** s (along the keys grip → pulled → hip → aim) as the pull eases out. */
const sOf = (u: number): number => {
  const v = MathUtils.clamp((u - U_GRIP) / (1 - U_GRIP), 0, 1)
  return 1 - (1 - v) * (1 - v)
}
/** The hip key sits at s = 2/3: u where sOf reaches it. */
const U_HIP = U_GRIP + (1 - U_GRIP) * (1 - Math.sqrt(1 / 3))
const FLINCH_S = 0.75
const SPIN_S = 1.05

export class DrawLayer {
  private readonly man: Armed
  private readonly anatomy: GunAnatomy
  private readonly bone: (n: string) => Bone | null
  private mode: Mode = 'off'
  private spec: DrawSpec = { secs: 0.3, turn: null, target: () => null }
  /** Draw progress 0..1, the overall weight (fades on release), seconds since the aim. */
  private u = 0
  private w = 0
  private fade = 0
  private settle = -1
  private t = 0
  /** The fan: the off hand over the hammer, 0..1, and its last slap. */
  private fan = 0
  private slap = 0
  private shots = 0
  private states: HandState[] = []
  private readonly spinFrom: GunPose[] = [gunPose(), gunPose()]
  private readonly k = [gunPose(), gunPose(), gunPose(), gunPose()]
  private readonly g = gunPose()
  /** Bones this frame's pass moved, as the clip left them (put back before the next mixer pass). */
  private readonly saved: { b: Bone; p: Vector3; q: Quaternion }[] = []

  constructor(man: Armed, anatomy: GunAnatomy, bone: (n: string) => Bone | null) {
    this.man = man
    this.anatomy = anatomy
    this.bone = bone
  }

  get active(): boolean {
    return this.mode !== 'off'
  }

  /** Has the gun(s) out of the leather. */
  get drawn(): boolean {
    return this.mode === 'draw' && this.u >= U_GRIP
  }

  /** Begin the draw (and the turn). */
  draw(spec: DrawSpec): void {
    this.begin('draw')
    this.spec = spec
  }

  /** The fake-out: a hand to the gun, an inch of it out, and back. */
  flinch(): void {
    if (this.mode === 'draw') {
      return
    }
    this.begin('flinch')
    this.spec = { secs: FLINCH_S, turn: null, target: () => null }
  }

  /** After a win: twirl it on the trigger finger and drop it in the holster. */
  spin(): void {
    if (!this.drawn) {
      return
    }
    for (const [i, s] of this.states.entries()) {
      const g = this.spinFrom[i]
      if (g) {
        const p = new Vector3()
        const q = new Quaternion()
        worldOf(s.wrist, p, q)
        const sw = s.wrist.getWorldScale(new Vector3()).x
        gunInHand({ wp: p, wq: q, sw, slot: s.h.slot, a: this.anatomy }, g)
      }
    }
    this.mode = 'spin'
    this.t = 0
  }

  /**
   * He fires: the gun is out and on his man this frame (a draw short of the hip jumps there, the
   * hip shot) and kicks. Two guns take turns; returns true when the off hand fired.
   */
  fire(): boolean {
    if (this.mode !== 'draw') {
      return false
    }
    const early = this.u < 0.8
    if (this.u < U_HIP) {
      this.u = U_HIP
      for (const s of this.states) {
        toHand(s, true)
      }
    }
    // from the hip (or by habit) the off hand fans the hammer
    if (this.states.length === 1 && (early || this.spec.off === 'fan')) {
      this.fan = 1
    }
    const which = this.shots++ % Math.max(1, this.states.length)
    const s = this.states[which]
    if (s) {
      s.kick = 1
    }
    this.slap = this.fan > 0 ? 1 : 0
    return which === 1
  }

  /** A clip that takes him over (a death, a hit) ends the draw. */
  onClip(name: string): void {
    if (name === 'Death' || name.startsWith('HitRecieve')) {
      this.release()
    }
  }

  /** Let the clip have him back over `secs` (a death, a hit). */
  release(secs = 0.15): void {
    if (this.mode !== 'off' && this.fade === 0) {
      this.fade = Math.max(0.01, secs)
    }
  }

  /** Stop at once (the gun goes wherever the caller puts it). */
  reset(): void {
    this.mode = 'off'
    this.w = 0
    this.fade = 0
    for (const s of this.states) {
      s.offP.set(0, 0, 0)
      s.offQ.identity()
    }
  }

  /**
   * Run whole draws through this code once (the turn, both off-hand habits, a hip shot, the spin)
   * and put him back exactly as he stood, so V8 has compiled it before the bell instead of on the
   * call's frame (7 ms of first-run JIT at the floor proxy). Call it at a level's setup, between
   * frames, while he's at ease with his gun(s) holstered; it does nothing mid-draw.
   */
  warm(target: () => Vector3 | null): void {
    if (this.mode !== 'off') {
      return
    }
    const yaw = this.man.root.rotation.y
    for (const off of ['steady', 'fan'] as const) {
      this.draw({ secs: 0.3, turn: { from: yaw, to: yaw + 0.5 }, target, off })
      const holsters = this.states.map((st) => st.h.gun.parent === st.h.holster)
      for (let i = 0; i < 10; i++) {
        this.update(0.05)
        if (i === 2) {
          this.fire()
        }
      }
      this.spin()
      this.update(0.1)
      this.reset()
      this.undo()
      for (const [i, st] of this.states.entries()) {
        if (holsters[i]) {
          toHolster(st)
        }
      }
    }
    this.man.root.rotation.y = yaw
    this.man.root.updateMatrixWorld(true)
  }

  private begin(mode: Mode): void {
    this.mode = mode
    this.u = 0
    this.t = 0
    this.w = 1
    this.fade = 0
    this.settle = -1
    this.fan = 0
    this.slap = 0
    this.shots = 0
    this.states = handStates(this.man, this.bone)
  }

  private rootQ(): Quaternion {
    return this.man.root.getWorldQuaternion(new Quaternion())
  }

  // ------------------------------------------------------------------ per frame

  /**
   * Before the mixer: put back what the last pass moved (a clip that doesn't key a bone, the hips'
   * height in Gun_Shoot, would otherwise keep every frame's nudge).
   */
  undo(): void {
    for (const s of this.saved) {
      s.b.position.copy(s.p)
      s.b.quaternion.copy(s.q)
    }
    this.saved.length = 0
  }

  private keep(...bones: (Bone | null)[]): void {
    for (const b of bones) {
      if (b && !this.saved.some((s) => s.b === b)) {
        this.saved.push({ b, p: b.position.clone(), q: b.quaternion.clone() })
      }
    }
  }

  /** After the mixer: advance by `dt` (game time) and pose him. */
  update(dt: number): void {
    if (this.mode === 'off') {
      return
    }
    this.advance(dt)
    if (!this.active) {
      return
    }
    const turn = this.spec.turn
    if (turn && this.mode === 'draw') {
      const k = ease(Math.min(1, this.u / U_TURN))
      this.man.root.rotation.y = MathUtils.lerp(turn.from, turn.to, k)
    }
    this.man.root.updateMatrixWorld(true)
    const chest = this.bone('Chest')
    if (!chest) {
      return
    }
    this.capture(chest)
    this.body()
    const target = this.aimPoint()
    for (const [i, s] of this.states.entries()) {
      this.arm(s, i, chest, target)
    }
    if (this.states.length === 1) {
      this.offHand(chest)
    }
  }

  private advance(dt: number): void {
    this.t += dt
    if (this.mode === 'draw') {
      this.u = Math.min(1, this.u + dt / Math.max(0.05, this.spec.secs))
      if (this.u >= 1) {
        this.settle = this.settle < 0 ? 0 : this.settle + dt
      }
    }
    const f = Math.exp(-dt / 0.03)
    for (const s of this.states) {
      s.kick *= Math.exp(-dt / 0.07)
      s.offP.multiplyScalar(f)
      s.offQ.slerp(new Quaternion(), 1 - f)
    }
    this.slap *= Math.exp(-dt / 0.06)
    if (
      (this.mode === 'flinch' && this.t >= FLINCH_S) ||
      (this.mode === 'spin' && this.t >= SPIN_S)
    ) {
      this.mode = 'off'
    }
    if (this.fade > 0) {
      this.w -= dt / this.fade
      if (this.w <= 0) {
        this.reset()
      }
    }
  }

  private aimPoint(): Vector3 {
    const t = this.spec.target()
    if (t) {
      return t
    }
    const r = this.man.root
    const fwd = new Vector3(0, 0, 1).applyQuaternion(this.rootQ())
    return r
      .getWorldPosition(new Vector3())
      .addScaledVector(fwd, 10)
      .setY(this.man.height * 0.75)
  }

  /** The clip's wrists and elbows, kept in his chest's frame (the body pass moves the chest). */
  private capture(chest: Bone): void {
    const inv = chest.matrixWorld.clone().invert()
    const cq = chest.getWorldQuaternion(new Quaternion()).invert()
    for (const s of this.states) {
      worldOf(s.wrist, s.clipP, s.clipQ)
      s.clipP.applyMatrix4(inv)
      s.clipQ.premultiply(cq)
      s.lower.getWorldPosition(s.elbow).applyMatrix4(inv)
    }
  }

  /** How far into the turn (0..1), and his sink into it (metres). */
  private turnShape(): { k: number; crouch: number; lean: number } {
    const h = this.man.height
    if (this.mode === 'spin') {
      return { k: 0, crouch: h * 0.012 * (1 - smooth(0.4, SPIN_S, this.t)) * this.w, lean: 0 }
    }
    if (this.mode !== 'draw') {
      return { k: 0, crouch: 0, lean: 0 }
    }
    const k = Math.min(1, this.u / U_TURN)
    return {
      k,
      crouch: h * (0.03 * Math.sin(Math.PI * k) + 0.012 * k) * this.w,
      lean: 0.1 * Math.sin(Math.PI * Math.min(1, this.u * 1.3)) * this.w,
    }
  }

  /** The turn and the crouch: hips lead, shoulders follow, head leads; the feet stay planted. */
  private body(): void {
    const b = this.bone
    const hips = b('Hips')
    if (!hips) {
      return
    }
    const feet = (['L', 'R'] as const).map((side) => {
      const foot = b(`Foot${side}`)
      const p = new Vector3()
      const q = new Quaternion()
      if (foot) {
        worldOf(foot, p, q)
      }
      return { side, foot, p, q }
    })
    const { k, crouch, lean } = this.turnShape()
    const turn = this.mode === 'draw' ? this.spec.turn : null
    const total = turn ? turn.to - turn.from : 0
    const at = (lead: number): number => ease(Math.min(1, k / lead))
    const lim = (a: number): number => MathUtils.clamp(a, -0.55, 0.55) * this.w
    const torso = b('Torso') ?? b('Abdomen')
    const neck = b('Neck') ?? b('Head')
    const chest = b('Chest')
    this.keep(hips, torso, neck, chest)
    moveWorld(hips, new Vector3(0, -crouch, 0))
    const yaw = (bone: Bone | null, a: number): void => {
      if (bone && a !== 0) {
        rotateWorld(bone, new Quaternion().setFromAxisAngle(UP, a))
      }
    }
    yaw(hips, lim((at(0.8) - ease(k)) * total))
    yaw(torso, lim((at(1.15) - at(0.8)) * total))
    yaw(neck, lim((at(0.55) - at(1.15)) * total))
    // a forward lean of the chest into the draw
    const rootQ = this.rootQ()
    if (chest && lean !== 0) {
      const right = new Vector3(1, 0, 0).applyQuaternion(rootQ)
      rotateWorld(chest, new Quaternion().setFromAxisAngle(right, lean))
    }
    const fwd = new Vector3(0, 0, 1).applyQuaternion(rootQ)
    for (const f of feet) {
      const upper = b(`UpperLeg${f.side}`)
      const lower = b(`LowerLeg${f.side}`)
      if (!(f.foot && upper && lower)) {
        continue
      }
      this.keep(upper, lower, f.foot)
      // knee forward, over the toes
      const pole = lower.getWorldPosition(new Vector3()).addScaledVector(fwd, 0.5)
      solveArm({ upper, lower, end: f.foot }, f.p, f.q, pole)
    }
  }

  /** The gun at its keys this frame: holstered, pulled, at the hip, aimed. */
  private keys(s: HandState, chest: Bone, target: Vector3): GunPose[] {
    const a = this.anatomy
    const [g1, g2, g3, g4] = this.k as [GunPose, GunPose, GunPose, GunPose]
    holstered(s.h.holster, a, g1)
    pulled(g1, a, g2)
    // the hip: a hand forward of the holster and up, level on his man, canted in a touch
    const hs = this.man.height / 1.78
    const fwd = target
      .clone()
      .sub(this.man.root.getWorldPosition(new Vector3()))
      .setY(0)
      .normalize()
    const hip = g2.p
      .clone()
      .addScaledVector(fwd, 0.16 * hs)
      .addScaledVector(UP, 0.02 * hs)
    levelPose(hip, target.clone().sub(hip), s.h.side === 'R' ? -0.25 : 0.25, g3)
    // the aim: the clip's, turned onto his man about the shoulder
    const wp = s.clipP.clone().applyMatrix4(chest.matrixWorld)
    const wq = s.clipQ.clone().premultiply(chest.getWorldQuaternion(new Quaternion()))
    const sw = s.wrist.getWorldScale(new Vector3()).x
    gunInHand({ wp, wq, sw, slot: s.h.slot, a }, g4)
    const fix = aimCorrection(g4, a, { target, max: 1.2 }, new Quaternion())
    swingAbout(g4, fix, s.upper.getWorldPosition(new Vector3()))
    return this.k
  }

  /** The gun pose this hand holds (or reaches for) right now, by mode; returns its weight. */
  private gunAt(i: number, keys: readonly GunPose[], out: GunPose): number {
    const [g1, g2, , g4] = keys as [GunPose, GunPose, GunPose, GunPose]
    const t = this.t
    if (this.mode === 'flinch') {
      // hand on the grip, an inch out, back in
      const lift = smooth(0.12, 0.26, t) * (1 - smooth(0.42, 0.56, t)) * 0.55
      out.p.lerpVectors(g1.p, g2.p, lift)
      out.q.copy(g1.q)
      return smooth(0, 0.12, t) * (1 - smooth(0.56, FLINCH_S, t))
    }
    if (this.mode === 'spin') {
      // up and over the holster as it twirls, then seated
      const from = this.spinFrom[i] ?? g4
      const a = ease(smooth(0, 0.62, t))
      const raised = copyPose(gunPose(), g2)
      raised.p.addScaledVector(UP, 0.04)
      out.p.lerpVectors(from.p, raised.p, a)
      out.q.copy(from.q).slerp(raised.q, a)
      const seat = smooth(0.62, 0.8, t)
      out.p.lerp(g1.p, seat)
      out.q.slerp(g1.q, seat)
      return 1 - smooth(0.8, SPIN_S, t)
    }
    // the draw; the off gun a beat behind the strong one
    alongKeys(keys, sOf(Math.max(0, this.u - i * 0.04)), out)
    if (this.settle >= 0) {
      const e = Math.exp(-this.settle / 0.07)
      pitch(out, 0.12 * e * Math.sin((this.settle / 0.17) * Math.PI * 2))
    }
    return 1
  }

  private arm(s: HandState, i: number, chest: Bone, target: Vector3): void {
    const a = this.anatomy
    const g = this.gunAt(i, this.keys(s, chest, target), this.g)
    // the recoil: the muzzle flips up about the grip, the hand rides back
    if (s.kick > 0.001) {
      pitch(this.g, 0.5 * s.kick)
      this.g.p.addScaledVector(new Vector3(1, 0, 0).applyQuaternion(this.g.q), -0.04 * s.kick)
    }
    const sw = s.wrist.getWorldScale(new Vector3()).x
    const tp = new Vector3()
    const tq = new Quaternion()
    wristFor(this.g, { sw, slot: s.h.slot, a }, tp, tq)
    // reaching for the grip: from the clip's hand onto the holstered gun
    const reach = this.mode === 'draw' ? ease(Math.min(1, this.u / U_GRIP)) : 1
    const clipP = s.clipP.clone().applyMatrix4(chest.matrixWorld)
    const clipQ = s.clipQ.clone().premultiply(chest.getWorldQuaternion(new Quaternion()))
    const k = Math.min(reach, g) * this.w
    tp.lerpVectors(clipP, tp, k)
    tq.copy(clipQ).slerp(tq.clone(), k)
    // elbow: back and out on the draw, the clip's own at the aim
    const outward = new Vector3(s.h.side === 'R' ? -1 : 1, 0, 0).applyQuaternion(this.rootQ())
    const shoulder = s.upper.getWorldPosition(new Vector3())
    const back = target.clone().sub(shoulder).setY(0).normalize().negate()
    const drawPole = shoulder
      .clone()
      .addScaledVector(outward, 0.2)
      .addScaledVector(back, 0.25)
      .addScaledVector(UP, -0.15)
    const aimPole = s.elbow.clone().applyMatrix4(chest.matrixWorld)
    const pole = drawPole.lerp(aimPole, this.mode === 'draw' ? smooth(0.45, 0.95, sOf(this.u)) : 0)
    this.keep(s.upper, s.lower, s.wrist)
    solveArm({ upper: s.upper, lower: s.lower, end: s.wrist }, tp, tq, pole)
    this.handOff(s, k)
    this.seat(s)
  }

  /** The gun changes hands where hand and holster meet. */
  private handOff(s: HandState, k: number): void {
    const grip = this.mode === 'draw' ? this.u >= U_GRIP : this.mode === 'flinch' && k > 0.98
    const seated =
      (this.mode === 'flinch' && this.t >= 0.56) || (this.mode === 'spin' && this.t >= 0.8)
    if (seated) {
      toHolster(s)
    } else if (grip) {
      toHand(s, false)
    }
  }

  /** The twirl: three turns on the trigger finger after a win; one on the boss's way up. */
  private seat(s: HandState): void {
    let turns = 0
    if (this.mode === 'spin') {
      turns = -3 * (1 - (1 - smooth(0.05, 0.62, this.t)) ** 2)
    } else if (this.mode === 'draw' && this.spec.flourish) {
      turns = smooth(0.4, 0.92, sOf(this.u))
    }
    seatGun(s, this.anatomy, turns)
  }

  /** The single-gun off hand: over to steady the grip as the clip has it, or palm down to fan. */
  private offHand(chest: Bone): void {
    const s = this.states[0]
    const upper = this.bone('UpperArmL')
    const lower = this.bone('LowerArmL')
    const wrist = this.bone('WristL')
    if (!(s && upper && lower && wrist) || this.mode !== 'draw') {
      return
    }
    const lp = new Vector3()
    const lq = new Quaternion()
    worldOf(wrist, lp, lq)
    const clip = {
      rp: s.clipP.clone().applyMatrix4(chest.matrixWorld),
      rq: s.clipQ.clone().premultiply(chest.getWorldQuaternion(new Quaternion())),
      lp,
      lq,
    }
    const t = offHandTarget(s, {
      bone: this.bone,
      a: this.anatomy,
      clip,
      sup: smooth(0.55, 1, sOf(this.u)) * this.w,
      fan: this.fan * this.w,
      slap: this.slap,
    })
    const pole = upper
      .getWorldPosition(new Vector3())
      .addScaledVector(UP, -0.4)
      .addScaledVector(new Vector3(1, 0, 0).applyQuaternion(this.rootQ()), 0.3)
    this.keep(upper, lower, wrist)
    solveArm({ upper, lower, end: wrist }, t.p, t.q, pole)
  }
}
