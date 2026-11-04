// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `bent` flips in layer(), which Actor.update calls back; Biome narrows it to its initialiser
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one rider's animation state machine (clip weights, the phase-locked gait, the bone layers, the body arcs)
/**
 * A skinned rider's animation, CoD style, from what the wire says he's doing: his `ANIM_*`, his
 * stance bits (crouched, on the sights, sprinting), his ground velocity and his aim.
 *
 * - The legs: one blend space over idle → walk → run → sprint (and crouch idle → crouch walk), the
 *   weights eased so every change crossfades, the cycles phase-locked and paced from his speed and
 *   each clip's measured stride, so the feet keep to the ground at any speed in between.
 * - Eight-way movement: the legs turn toward where he's going (up to 75° off his aim, or
 *   backpedalling with the cycle run backwards) while his spine turns back, so his chest and gun
 *   stay on his aim; a lean into the turn.
 * - The upper body: the gun arm comes up (aiming, firing, on the sights), the reload clip and the
 *   hit flinches play over the legs, his spine follows the aim's pitch (your own rider).
 * - Whole-body moves the clips don't have: the jump and vault arcs (the jump clip in the air), the
 *   landing dip, the slide (crouched, leaning back), the roll, and three deaths (back, twisting,
 *   mirrored), turned to fall away from the shot that killed him.
 *
 * Weights all ease at one rate, so they always sum to one (a partial sum would blend toward the
 * bind pose).
 */
import {
  type AnimationAction,
  AnimationClip,
  type Bone,
  LoopOnce,
  LoopRepeat,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import {
  ANIM_AIM,
  ANIM_CHANNEL,
  ANIM_DEAD,
  ANIM_DUEL,
  ANIM_HOP,
  ANIM_RELOAD,
  ANIM_ROLL,
  ANIM_SLIDE,
  ANIM_VAULT,
  STANCE_ADS,
  STANCE_CROUCH,
  STANCE_SPRINT,
} from '../../contract/town.ts'
import type { Actor } from '../../scene/actor.ts'
import type { Clip } from '../../scene/clips.ts'
import { solveArm } from '../../scene/longgun.ts'
import { measureStride } from '../../scene/rig.ts'
import { SupportHand } from './mirror-hand.ts'

/** Base (full-body) clips, in blend order. */
const BASE = [
  'Idle',
  'Idle_Gun',
  'Idle_Gun_Pointing',
  'Walk',
  'Run',
  'Sprint',
  'Crouch_Idle',
  'Crouch_Walk',
  'Jump_Loop',
  'Idle_Neutral',
  'Death',
] as const satisfies readonly Clip[]
type Base = (typeof BASE)[number]
const CYCLES = ['Walk', 'Run', 'Sprint', 'Crouch_Walk'] as const satisfies readonly Base[]
type Cycle = (typeof CYCLES)[number]
/** Ground speed each cycle was authored at (m/s), until his stride measures it. */
// biome-ignore lint/style/useNamingConvention: the game's clip names
const AUTHORED: Record<Cycle, number> = { Walk: 1.4, Run: 5.2, Sprint: 7.2, Crouch_Walk: 1.6 }
const UPPER =
  /^(?:Abdomen|Torso|Chest|Neck|Head|Shoulder[LR]|UpperArm[LR]|LowerArm[LR]|Wrist[LR]|(?:Index|Middle|Ring|Pinky|Thumb)\d[LR])$/u
const ARM_R = /^(?:Shoulder|UpperArm|LowerArm|Wrist|Index|Middle|Ring|Pinky|Thumb)\d?R$/u
/** How fast base weights ease (1/s): ~0.15 s crossfades. */
const BLEND = 14
/** Legs turn at most this far off the aim (rad). */
const MAX_LEG_YAW = 1.3
const ROLL_S = 0.35
const VAULT_S = 0.5
const VAULT_PEAK_M = 0.75
const HOP_S = 0.55
const HOP_PEAK_M = 0.45
/** How the spine (abdomen, torso, chest) shares the twist back to the aim, and the aim's pitch. */
const TWIST = [0.3, 0.3, 0.4] as const
const PITCH = [0.25, 0.35, 0.4] as const
/** Measured strides, per base body and clip (m per cycle). */
const strides = new Map<string, number>()

export interface LocoInput {
  anim: number
  stance: number
  vx: number
  vz: number
  /** Aim yaw (rad, sim convention) and pitch (rad, up positive; 0 when unknown). */
  aim: number
  pitch: number
  holstered: boolean
  /** A long gun in his hands (it has its own hold). */
  long: boolean
  /** Fired in the last moment: the gun arm stays up. */
  shooting: boolean
  /** Close enough for the fine work (the support hand's IK and fingers): yours, or within 12 m. */
  detail: boolean
}

const up = new Vector3(0, 1, 0)
const tmpQ = new Quaternion()
const tmpQ2 = new Quaternion()
const tmpV = new Vector3()

/** Rotate a bone about a world axis by `angle` (its parent's world matrix must be current). */
function turnWorld(b: Bone, axis: Vector3, angle: number): void {
  if (angle === 0) {
    return
  }
  const pq = b.parent ? b.parent.getWorldQuaternion(tmpQ2) : tmpQ2.identity()
  const local = tmpV.copy(axis).applyQuaternion(pq.invert())
  b.quaternion.premultiply(tmpQ.setFromAxisAngle(local, angle))
}

function blend01(v: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, (v - lo) / Math.max(1e-3, hi - lo)))
}

function upperClip(src: AnimationClip, name: string, filter: RegExp): AnimationClip {
  const tracks = src.tracks.filter((t) => filter.test(t.name.split('.')[0] ?? ''))
  return new AnimationClip(name, src.duration, tracks)
}

export class Locomotion {
  private readonly actor: Actor
  private readonly base = new Map<Base, AnimationAction>()
  private readonly w = new Map<Base, number>()
  private readonly stride = new Map<Cycle, number>()
  private readonly arm: AnimationAction | null
  private readonly reload: AnimationAction | null
  private readonly hits: AnimationAction[] = []
  /** The pistol shot, over the gun arm and chest, once per shot. */
  private readonly shoot: AnimationAction | null
  private shootW = 0
  /** A shot's kick (1 at the shot, settling): the chest and the gun arm rock back and up. */
  private kick = 0
  /** On the sights, eased 0..1: the gun at eye line, the left hand wrapping the right. */
  private adsW = 0
  private readonly support: SupportHand | null
  /**
   * Every bone's rotation as the clips left it, saved before the procedural layer bends it and put
   * back before the next mixer update: the mixer skips writing a value that hasn't changed since
   * its last write, so a bend left in place would pile up tick after tick on a still clip.
   */
  private readonly clean: Quaternion[] = []
  private readonly bones: Bone[] = []
  private bent = false
  private readonly bone = new Map<string, Bone>()
  private phase = Math.random()
  private legYaw = 0
  private lean = 0
  private armW = 0
  private reloadW = 0
  private hitW = 0
  private flinch = 0
  private flinchDir = 0
  private dip = 0
  private dipV = 0
  private was = -1
  private since = 0
  private deathKind = 0
  private deathYaw = 0
  private input: LocoInput = {
    anim: 0,
    stance: 0,
    vx: 0,
    vz: 0,
    aim: 0,
    pitch: 0,
    holstered: true,
    long: false,
    shooting: false,
    detail: false,
  }

  constructor(actor: Actor, clips: readonly AnimationClip[], bodyKey: string) {
    this.actor = actor
    actor.root.traverse((o) => {
      if ((o as Partial<Bone>).isBone === true) {
        this.bone.set(o.name, o as Bone)
      }
    })
    const find = (n: string) => clips.find((c) => (c.name.split('|').pop() ?? c.name) === n)
    // strides first (measuring poses the mixer), then the actions
    this.measureStrides(find, bodyKey)
    actor.mixer.stopAllAction()
    for (const n of BASE) {
      const a = actor.action(n)
      if (!a) {
        continue
      }
      a.reset()
      a.enabled = true
      a.setLoop(n === 'Death' ? LoopOnce : LoopRepeat, n === 'Death' ? 1 : Number.POSITIVE_INFINITY)
      a.clampWhenFinished = n === 'Death'
      a.setEffectiveWeight(0)
      a.play()
      if ((CYCLES as readonly string[]).includes(n)) {
        a.timeScale = 0
      }
      this.base.set(n, a)
      this.w.set(n, 0)
    }
    this.w.set('Idle_Gun', 1)
    this.base.get('Idle_Gun')?.setEffectiveWeight(1)
    const layer = (n: string, name: string, f: RegExp, loop: boolean) => {
      const src = find(n)
      if (!src) {
        return null
      }
      const a = actor.mixer.clipAction(upperClip(src, name, f))
      a.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Number.POSITIVE_INFINITY : 1)
      a.clampWhenFinished = !loop
      a.setEffectiveWeight(0)
      a.play()
      return a
    }
    this.arm = layer('Idle_Gun_Pointing', 'LocoArm', ARM_R, true)
    this.shoot = layer('Idle_Gun_Shoot', 'LocoShoot', ARM_R, false)
    this.shoot?.stop()
    this.reload = layer('Reload', 'LocoReload', UPPER, true)
    for (const n of ['HitRecieve', 'HitRecieve_2']) {
      const a = layer(n, `Loco${n}`, UPPER, false)
      if (a) {
        a.stop()
        this.hits.push(a)
      }
    }
    // the support hand's mirror pairs, measured in the bind pose (symmetric, unlike any clip's)
    const skel = actor.meshes[0]?.skeleton
    if (skel) {
      // (put every bone back after: pose() also moves bones no clip animates)
      const saved = skel.bones.map(
        (b) => [b.position.clone(), b.quaternion.clone(), b.scale.clone()] as const,
      )
      skel.pose()
      actor.root.updateMatrixWorld(true)
      const side = new Vector3(1, 0, 0).applyQuaternion(actor.root.getWorldQuaternion(tmpQ))
      this.support = new SupportHand(this.bone, side)
      for (const [k, b] of skel.bones.entries()) {
        const s0 = saved[k]
        if (s0) {
          b.position.copy(s0[0])
          b.quaternion.copy(s0[1])
          b.scale.copy(s0[2])
          b.updateMatrix()
        }
      }
      actor.root.updateMatrixWorld(true)
    } else {
      this.support = null
    }
    // the procedural layer runs inside Actor.update, after the clips and before the long-gun IK
    actor.layer = () => this.layer()
  }

  /** Each cycle's stride (m per cycle), measured once per base body. */
  private measureStrides(find: (n: string) => AnimationClip | undefined, bodyKey: string): void {
    const feet = [this.bone.get('FootL'), this.bone.get('FootR')] as const
    for (const c of CYCLES) {
      const key = `${bodyKey}:${c}`
      let len = strides.get(key)
      const clip = find(c)
      if (len === undefined && clip && feet[0] && feet[1]) {
        const m = measureStride(
          { mixer: this.actor.mixer, root: this.actor.root, feet: [feet[0], feet[1]] },
          clip,
        )
        len = m.paceLength ? 2 * m.paceLength : AUTHORED[c] * clip.duration
        strides.set(key, len)
      }
      this.stride.set(c, len ?? AUTHORED[c] * (clip?.duration ?? 1))
    }
  }

  set(i: LocoInput): void {
    this.input = i
  }

  /** He fired: the shot clip over the gun arm, and a kick through the chest and arm. */
  fired(): void {
    this.shoot?.reset().play()
    this.shootW = 1
    this.kick = 1
    this.armW = 7
  }

  /** A hit from direction (dx, dz) (world, toward him): flinch away and play a hit clip. */
  hit(dx: number, dz: number): void {
    const a = this.hits[Math.floor(Math.random() * this.hits.length)]
    if (a) {
      a.reset().play()
      this.hitW = 1
    }
    this.flinch = 1
    // which way, relative to his facing: + from his front
    const f = Math.atan2(-dz, -dx) - this.input.aim
    this.flinchDir = Math.cos(f)
  }

  /** He died: pick a fall (by `seed`), turned to fall away from (`fx`, `fz`) if known. */
  died(seed: number, from: { x: number; z: number } | null, at: { x: number; z: number }): void {
    this.deathKind = seed % 3
    this.deathYaw = from ? Math.atan2(from.z - at.z, from.x - at.x) - this.input.aim : 0
  }

  /**
   * Before `actor.update(dt)`: ease the clip weights toward this state's mix and pace the cycles.
   * `dt` is the time since his last update (his mixer may tick at 15 or 30 Hz).
   */
  pre(dt: number): void {
    this.unbend()
    const i = this.input
    if (i.anim !== this.was) {
      if (i.anim === ANIM_DEAD) {
        this.base.get('Death')?.reset().play()
      }
      if (this.was === ANIM_HOP || this.was === ANIM_VAULT) {
        // the landing
        this.dipV -= i.anim === ANIM_DEAD ? 0 : 2.2
      }
      this.was = i.anim
      this.since = 0
    }
    this.since += dt
    const speed = Math.hypot(i.vx, i.vz)
    const target = this.mix(i, speed)
    const k = 1 - Math.exp(-dt * (i.anim === ANIM_DEAD ? 30 : BLEND))
    for (const [n, a] of this.base) {
      const t = target.get(n) ?? 0
      const w = (this.w.get(n) ?? 0) + (t - (this.w.get(n) ?? 0)) * k
      this.w.set(n, w)
      a.setEffectiveWeight(w)
    }
    this.pace(dt, speed, i)
    this.upper(dt, speed)
  }

  /** The upper body's layers: the gun arm, the reload, hits, the shot, the sights. */
  private upper(dt: number, speed: number): void {
    const i = this.input
    const crouched = (i.stance & STANCE_CROUCH) !== 0
    const armUp =
      !(i.holstered || i.long) &&
      i.anim !== ANIM_DEAD &&
      i.anim !== ANIM_RELOAD &&
      ((i.stance & STANCE_ADS) !== 0 ||
        i.anim === ANIM_AIM ||
        i.shooting ||
        speed > 0.3 ||
        crouched)
    const sprinting = (i.stance & STANCE_SPRINT) !== 0
    this.armW += ((armUp && !sprinting ? 7 : 0) - this.armW) * (1 - Math.exp(-dt * 12))
    this.arm?.setEffectiveWeight(this.armW)
    const reloading = i.anim === ANIM_RELOAD && !i.long
    this.reloadW += ((reloading ? 6 : 0) - this.reloadW) * (1 - Math.exp(-dt * 10))
    this.reload?.setEffectiveWeight(this.reloadW)
    this.hitW = Math.max(0, this.hitW - dt * 2.2)
    for (const a of this.hits) {
      a.setEffectiveWeight(this.hitW * 3)
    }
    this.flinch = Math.max(0, this.flinch - dt * 4)
    this.kick = Math.max(0, this.kick - dt * 7)
    this.shootW = Math.max(0, this.shootW - dt * 2.5)
    this.shoot?.setEffectiveWeight(this.shootW * 9)
    const sighted = (i.stance & STANCE_ADS) !== 0 && !i.holstered && !i.long
    this.adsW += ((sighted ? 1 : 0) - this.adsW) * (1 - Math.exp(-dt * 12))
    // the landing dip: a spring
    this.dipV += (-90 * this.dip - 14 * this.dipV) * dt
    this.dip += this.dipV * dt
    // a long gun: shouldered on the sights or firing, at the low ready at the hip, slung on the run
    let carry = 0.45
    if (sprinting) {
      carry = 1
    } else if ((i.stance & STANCE_ADS) !== 0 || i.shooting || i.anim === ANIM_AIM) {
      carry = 0
    }
    this.actor.longCarry += (carry - this.actor.longCarry) * (1 - Math.exp(-dt * 10))
  }

  /** Put back the rotations the clips left, before the mixer runs again. */
  private unbend(): void {
    if (!this.bent) {
      return
    }
    this.bent = false
    for (const [k, b] of this.bones.entries()) {
      const q = this.clean[k]
      if (q) {
        b.quaternion.copy(q)
      }
    }
  }

  /** The base clips' target weights for this state. */
  private mix(i: LocoInput, speed: number): Map<Base, number> {
    const t = new Map<Base, number>()
    const a = i.anim
    if (a === ANIM_DEAD) {
      t.set('Death', 1)
      return t
    }
    if (a === ANIM_HOP || a === ANIM_VAULT) {
      t.set('Jump_Loop', 1)
      return t
    }
    if (a === ANIM_CHANNEL) {
      t.set('Idle_Neutral', 1)
      return t
    }
    if (a === ANIM_DUEL) {
      t.set('Idle', 1)
      return t
    }
    const crouched = (i.stance & STANCE_CROUCH) !== 0 || a === ANIM_SLIDE
    if (crouched && this.base.has('Crouch_Idle')) {
      const cw = a === ANIM_SLIDE ? 0 : blend01(speed, 0.2, this.speedOf('Crouch_Walk') * 0.8)
      t.set('Crouch_Walk', cw)
      t.set('Crouch_Idle', 1 - cw)
      return t
    }
    // on the sights he stands tall (the aiming clip hunches him): the arm layer raises the gun
    const stand: Base = i.holstered ? 'Idle' : 'Idle_Gun'
    const sprint = (i.stance & STANCE_SPRINT) !== 0 && this.base.has('Sprint')
    const walkV = this.speedOf('Walk')
    const runV = this.speedOf('Run')
    if (a === ANIM_ROLL || speed > 0.25 || sprint) {
      if (sprint) {
        const s = blend01(speed, runV * 0.8, runV * 1.25)
        t.set('Sprint', Math.max(0.6, s))
        t.set('Run', 1 - Math.max(0.6, s))
      } else if (speed <= walkV) {
        const w = blend01(speed, 0.05, walkV)
        t.set('Walk', w)
        t.set(stand, 1 - w)
      } else {
        const r = blend01(speed, walkV, Math.min(runV, 4.4))
        t.set('Run', r)
        t.set('Walk', 1 - r)
      }
      return t
    }
    t.set(stand, 1)
    return t
  }

  /** A cycle's ground speed at its authored rate (m/s), from his measured stride. */
  private speedOf(c: Cycle): number {
    const a = this.base.get(c)
    const dur = a?.getClip().duration ?? 1
    return (this.stride.get(c) ?? AUTHORED[c] * dur) / dur
  }

  /**
   * One phase for every cycle: advanced at his speed over the weighted stride (backwards when he
   * backpedals), and the legs turned toward where he's going.
   */
  private pace(dt: number, speed: number, i: LocoInput): void {
    let len = 0
    let wsum = 0
    for (const c of CYCLES) {
      const w = this.w.get(c) ?? 0
      len += (this.stride.get(c) ?? 1) * w
      wsum += w
    }
    // movement relative to the aim: legs within ±75°, backwards past 105°
    let rel = 0
    let dir = 1
    if (speed > 0.3) {
      rel = Math.atan2(i.vz, i.vx) - i.aim
      rel = Math.atan2(Math.sin(rel), Math.cos(rel))
      if (Math.abs(rel) > Math.PI * 0.58) {
        dir = -1
        rel = Math.atan2(Math.sin(rel + Math.PI), Math.cos(rel + Math.PI))
      }
    }
    const sprinting = (i.stance & STANCE_SPRINT) !== 0
    const wantYaw =
      i.anim === ANIM_SLIDE || i.anim === ANIM_ROLL || sprinting
        ? 0
        : Math.max(-MAX_LEG_YAW, Math.min(MAX_LEG_YAW, rel))
    this.legYaw += (wantYaw - this.legYaw) * (1 - Math.exp(-dt * 10))
    this.lean +=
      ((speed > 0.3 ? Math.sin(rel) * Math.min(1, speed / 6) : 0) - this.lean) *
      (1 - Math.exp(-dt * 6))
    if (wsum > 0.01 && len > 0.01) {
      const cps = speed / (len / wsum)
      this.phase = (this.phase + dir * cps * dt + 1) % 1
    }
    for (const c of CYCLES) {
      const a = this.base.get(c)
      if (a) {
        a.time = this.phase * a.getClip().duration
      }
    }
  }

  /** After the clips: legs to the movement, spine back to the aim, aim pitch, flinch. */
  private layer(): void {
    const hips = this.bone.get('Hips')
    const spine = ['Abdomen', 'Torso', 'Chest'].map((n) => this.bone.get(n))
    if (!hips || this.input.anim === ANIM_DEAD) {
      return
    }
    if (this.bones.length === 0) {
      this.bones.push(...this.bone.values())
      for (const b of this.bones) {
        this.clean.push(b.quaternion.clone())
      }
    }
    for (const [k, b] of this.bones.entries()) {
      this.clean[k]?.copy(b.quaternion)
    }
    this.bent = true
    this.actor.root.updateMatrixWorld(true)
    const yaw = this.legYaw
    // the hips turn the legs (and everything above); the spine turns the rest back
    // the sim measures angles toward +z, a turn about +y the other way: hence the minus
    turnWorld(hips, up, -yaw)
    for (const [k, b] of spine.entries()) {
      if (b) {
        turnWorld(b, up, yaw * (TWIST[k] ?? 0))
      }
    }
    const pitch = Math.max(-0.7, Math.min(0.7, this.input.pitch))
    const fl =
      this.flinch * this.flinch * 0.35 * this.flinchDir -
      this.kick * this.kick * 0.22 * (1 - 0.5 * this.adsW)
    if (pitch !== 0 || fl !== 0 || this.lean !== 0 || this.adsW > 0.01) {
      hips.updateMatrixWorld(true)
      const right = tmpV.set(0, 0, 0)
      const q = this.actor.root.getWorldQuaternion(tmpQ)
      right.set(-1, 0, 0).applyQuaternion(q)
      const r = right.clone()
      const fwd = new Vector3(0, 0, 1).applyQuaternion(q)
      for (const [k, b] of spine.entries()) {
        if (b) {
          const share = PITCH[k] ?? 0
          turnWorld(b, r, (pitch + fl) * share)
          turnWorld(b, fwd, -this.lean * 0.12 * share)
        }
      }
      // the gun arm: up to the eye line on the sights, and kicked up by a shot
      const arm = this.bone.get('UpperArmR')
      const fore = this.bone.get('LowerArmR')
      if (arm && fore) {
        arm.parent?.updateMatrixWorld(true)
        turnWorld(arm, r, this.adsW * 0.22 + this.kick * this.kick * 0.3)
        arm.updateMatrixWorld(true)
        turnWorld(fore, r, this.kick * this.kick * 0.35)
      }
      if (this.adsW > 0.05 && this.input.detail) {
        this.twoHands()
      }
    }
  }

  /** On the sights with the revolver: the left hand comes across and wraps the right. */
  private twoHands(): void {
    const sh = this.support
    const gun = this.actor.gun
    const a = this.actor.anatomy
    const upper = this.bone.get('UpperArmL')
    const lower = this.bone.get('LowerArmL')
    const end = this.bone.get('WristL')
    if (!(sh && gun && a && upper && lower && end && gun.parent)) {
      return
    }
    this.actor.root.updateMatrixWorld(true)
    const on = tmpV.copy(a.grip).applyMatrix4(gun.matrixWorld)
    const n = new Vector3().setFromMatrixColumn(gun.matrixWorld, 2).setY(0).normalize()
    const up2 = new Vector3().setFromMatrixColumn(gun.matrixWorld, 1).normalize()
    const tp = new Vector3()
    const tq = new Quaternion()
    if (!sh.target(on, n, tp, tq)) {
      return
    }
    tp.addScaledVector(up2, -0.02)
    // eased in from wherever the clip holds it
    const w = this.adsW
    const cur = end.getWorldPosition(new Vector3())
    tp.lerp(cur, 1 - w)
    tq.slerp(end.getWorldQuaternion(new Quaternion()), 1 - w)
    const pole = upper.getWorldPosition(new Vector3()).addScaledVector(up, -0.6)
    solveArm({ upper, lower, end }, tp, tq, pole)
    if (w > 0.5) {
      sh.fingersLike(n)
    }
  }

  /**
   * The whole body this frame: jump and vault arcs, the landing dip, the slide's lean, the roll,
   * the death's turn. `holder` stands on the ground at his feet; `pivot` turns about his hips.
   */
  body(holder: Object3D, pivot: Object3D): void {
    const a = this.input.anim
    const t = this.since
    let y = Math.min(0, this.dip) * 0.12
    let rx = 0
    let ry = 0
    if (a === ANIM_ROLL) {
      rx = Math.min(1, t / ROLL_S) * Math.PI * 2
    } else if (a === ANIM_VAULT || a === ANIM_HOP) {
      const vault = a === ANIM_VAULT
      const u = Math.min(1, t / (vault ? VAULT_S : HOP_S))
      y += (vault ? VAULT_PEAK_M : HOP_PEAK_M) * 4 * u * (1 - u)
      rx = vault ? 0.45 * Math.sin(Math.PI * u) : 0.12 * Math.sin(Math.PI * u)
    } else if (a === ANIM_SLIDE) {
      // low and leaning back, feet first
      const u = Math.min(1, t / 0.1)
      rx = -0.85 * u
      y -= 0.3 * u
    } else if (a === ANIM_DEAD) {
      ry = this.deathYaw
      if (this.deathKind === 1) {
        ry += Math.min(1, t / 0.8) * 0.9
      }
    }
    holder.position.y = y
    pivot.rotation.x = rx
    pivot.rotation.y = ry
    pivot.scale.x = a === ANIM_DEAD && this.deathKind === 2 ? -1 : 1
  }

  dispose(): void {
    this.actor.layer = null
  }
}
