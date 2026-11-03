// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Bone,
  Group,
  LoopOnce,
  LoopRepeat,
  type Material,
  type Mesh,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { BodyKey, HatKey } from '../data/outlaws.ts'
import { bake, bodyPieces, meshPieces, onBone, type Piece } from './bake.ts'
import { boneKey, bounds, sampleBody } from './fit.ts'
import { fitHat, type HatFit, tuckHair } from './hats.ts'
import { type HolsterLook, holsterParts, mergedProp, PLAIN_HOLSTER } from './kit.ts'
import { type Fit, measure, outerThigh, prune } from './outfit.ts'
import { watchPose } from './pose-watch.ts'
import { dressPieces, measureStride, seatHat, slotOn, tintModel } from './rig.ts'
import { characterMaterial } from './shade.ts'
import type { Floor } from './style.ts'

const HEIGHT = 1.78

export interface ActorOpts {
  /** Which whole base character this is (prunes its hard hat, crown, mohawk, backpack). */
  base?: BodyKey | null
  /** Animation clips, when the base file carries none (they share the player's rig). */
  clips?: readonly AnimationClip[] | null
  tint?: Readonly<Record<string, number>>
  hat?: HatKey | null
  hatColor?: number
  bandana?: number | undefined
  /** Revolver geometry to clone into the holster/hand. */
  gun?: Object3D | null
  /** Second gun (two-gun Delmer, Hardin). */
  offGun?: boolean
  rifle?: Object3D | null
  /** Uniform build: 1 = a 1.78 m man. */
  scale?: number
  coat?: number | undefined
  poncho?: number | undefined
  moustache?: number | undefined
  beard?: number | undefined
  bandoliers?: boolean | undefined
  star?: boolean | undefined
  mask?: number | undefined
  /** Seed for the subtle per-material colour/roughness variation. */
  seed?: string
  /** The holster cosmetic (leather colour, tooling, a buscadero drop loop). Looks only. */
  holster?: HolsterLook | undefined
}

/** An action posing him: scheduled on its mixer and enabled (a paused, clamped clip still holds). */
function posing(a: AnimationAction): boolean {
  return a.enabled && a.isScheduled()
}

export type Clip =
  | 'Idle'
  | 'Idle_Neutral'
  | 'Idle_Gun'
  | 'Idle_Gun_Pointing'
  | 'Idle_Gun_Shoot'
  | 'Gun_Shoot'
  | 'Walk'
  | 'Run'
  | 'Death'
  | 'HitRecieve'
  | 'HitRecieve_2'
  | 'Wave'

export class Actor {
  readonly root = new Group()
  readonly model: Object3D
  readonly mixer: AnimationMixer
  private readonly actions = new Map<string, AnimationAction>()
  readonly head: Bone | null
  readonly handR: Bone | null
  readonly handL: Bone | null
  readonly hips: Bone | null
  readonly spine: Bone | null
  readonly armR: Bone | null
  readonly forearmR: Bone | null
  hat: Group | null = null
  gun: Object3D | null = null
  offGun: Object3D | null = null
  rifle: Object3D | null = null
  private holster: Group | null = null
  private handSlot: Group | null = null
  private offSlot: Group | null = null
  private offHolster: Group | null = null
  /** The baked character: body and every garment in one skinned mesh. */
  readonly meshes: SkinnedMesh[] = []
  /** Distance travelled per pace at full stride (measured from the walk clip). */
  paceLength = 0.75
  /** Walk clip time of each heel strike. */
  heelStrikes: number[] = [0, 0.66]
  walkDuration = 1.33
  private readonly walkAction: AnimationAction | null = null
  private readonly idleAction: AnimationAction | null = null
  private current: AnimationAction | null = null
  walkWeight = 0
  /** Procedural layers. */
  sway = 0
  shake = 0
  twitch = 0
  private t = Math.random() * 10
  height = HEIGHT
  /** World height of his feet, for the shader's contact darkening. */
  readonly floor: Floor = { value: 0 }
  private readonly bones = new Map<string, Bone>()
  /** The base carries a sculpted beard (kept by prune when he wears one). */
  private realBeard = false
  /** Where his hat sits (null when he has none); the VAT crowd reads it through `hat`. */
  hatFit: HatFit | null = null
  /** Set by dispose() (the dev pose watchdog forgets him). */
  disposed = false
  /** What the dev pose watchdog calls him. */
  readonly label: string

  constructor(gltf: GLTF, opts: ActorOpts = {}) {
    this.label = `${opts.base ?? 'player'} ${opts.seed ?? ''}`.trim()
    this.model = cloneSkinned(gltf.scene)
    prune(this.model, { beard: opts.beard !== undefined })
    this.model.traverse((o) => {
      const b = o as Bone
      if (b.isBone) {
        this.bones.set(boneKey(b.name), b)
      }
      const m = o as Mesh
      if (m.isMesh && (m.material as Material).name === 'Beard') {
        this.realBeard = true
      }
    })
    this.root.add(this.model)
    // Normalise to a 1.78 m man, then his build, uniformly: everything he
    // wears and carries rides on bones, and only a uniform scale keeps it true.
    this.root.updateMatrixWorld(true)
    const rest = bounds(sampleBody(this.model, this.root).samples)
    const s = opts.scale ?? 1
    const k = (HEIGHT / Math.max(0.01, rest.max.y - rest.min.y)) * s
    this.model.scale.multiplyScalar(k)
    this.model.position.y = -rest.min.y * k
    this.height = HEIGHT * s
    this.root.updateMatrixWorld(true)

    this.head = this.bone('Head')
    this.handR = this.bone('WristR') ?? this.bone('FistR')
    this.handL = this.bone('WristL') ?? this.bone('FistL')
    this.hips = this.bone('Hips')
    this.spine = this.bone('Torso') ?? this.bone('Abdomen')
    this.armR = this.bone('UpperArmR')
    this.forearmR = this.bone('LowerArmR')

    this.mixer = new AnimationMixer(this.model)
    const clips = opts.clips && opts.clips.length > 0 ? opts.clips : gltf.animations
    for (const clip of clips) {
      const name = clip.name.split('|').pop() ?? clip.name
      this.actions.set(name, this.mixer.clipAction(clip))
    }
    this.walkAction = this.actions.get('Walk') ?? null
    this.idleAction = this.actions.get('Idle') ?? null
    if (this.walkAction) {
      this.walkDuration = this.walkAction.getClip().duration
      this.measureWalk(this.walkAction.getClip())
    }
    this.play('Idle', 0)
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)

    tintModel(this.model, opts)

    // Dress him in the idle pose, fitted to his own surface, then bake it all
    // into one skinned mesh bound in that pose.
    const body = sampleBody(this.model, this.root)
    const fit = measure(body, this.bones)
    const clothes = dressPieces(fit, opts, this.root, this.realBeard)
    const pieces = [...bodyPieces(this.model, this.root, body), ...clothes]
    // the hat is fitted to his skull now, so the hair it covers is pressed under it before baking
    this.hatFit = opts.hat ? fitHat(body, fit.head.eye, opts.hat) : null
    if (this.hatFit) {
      tuckHair(pieces, this.hatFit)
    }
    if (opts.gun) {
      pieces.push(
        ...this.placeHolsters(fit, {
          gun: opts.gun,
          two: opts.offGun ?? false,
          clothes,
          look: opts.holster ?? PLAIN_HOLSTER,
        }),
      )
    }
    const drop: Object3D[] = []
    this.model.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) {
        drop.push(o)
      }
    })
    for (const d of drop) {
      d.removeFromParent()
    }
    this.meshes.push(bake(pieces, body, this.root, characterMaterial(this.floor)))

    if (this.hatFit && this.head) {
      this.hat = seatHat(
        this.hatFit,
        { color: opts.hatColor ?? 0x3a_2a_1a, floor: this.floor },
        { head: this.head, root: this.root },
      )
    }
    if (opts.gun) {
      this.gripGuns(opts.offGun ?? false)
    }
    if (opts.rifle) {
      this.attachRifle(opts.rifle)
    }
    watchPose(this)
  }

  private bone(name: string): Bone | null {
    return this.bones.get(boneKey(name)) ?? null
  }

  /** Stride length and heel strikes from the walk clip, so his feet never slide. */
  private measureWalk(clip: AnimationClip): void {
    const footL = this.bone('FootL')
    const footR = this.bone('FootR')
    if (!(footL && footR)) {
      return
    }
    const stride = measureStride({ mixer: this.mixer, root: this.root, feet: [footL, footR] }, clip)
    this.paceLength = stride.paceLength ?? this.paceLength
    this.heelStrikes = stride.heelStrikes
  }

  action(name: Clip): AnimationAction | null {
    return this.actions.get(name) ?? null
  }

  /** Crossfade to a clip. */
  play(name: Clip, fade = 0.2, once = false, timeScale = 1): AnimationAction | null {
    const a = this.actions.get(name)
    if (!a) {
      return null
    }
    // Already playing it. "Current" alone isn't enough: a clip stopped behind play()'s back
    // (mixer.stopAllAction) left as current would keep him in his bind pose, a T-pose.
    if (this.current === a && !once && posing(a)) {
      return a
    }
    a.enabled = true
    a.reset()
    a.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Number.POSITIVE_INFINITY)
    a.clampWhenFinished = once
    a.timeScale = timeScale
    a.setEffectiveWeight(1)
    a.play()
    if (this.current && this.current !== a) {
      if (fade > 0) {
        this.current.crossFadeTo(a, fade, false)
      } else {
        this.current.stop()
      }
    }
    if (this.walkAction && this.walkAction !== a && this.walkWeight > 0) {
      this.walkAction.fadeOut(fade)
      this.walkWeight = 0
    }
    this.current = a
    return a
  }

  /** Locomotion blend: speed 0..1 drives walk weight and cadence. */
  locomote(speed: number, cadence: number): void {
    const w = this.walkAction
    const idle = this.idleAction
    if (!(w && idle)) {
      return
    }
    if (this.current !== idle || !posing(idle)) {
      this.play('Idle', 0.15)
    }
    if (!w.isRunning()) {
      w.reset().play()
      w.setLoop(LoopRepeat, Number.POSITIVE_INFINITY)
    }
    const s = Math.min(1, Math.max(0, speed))
    const weight = s < 0.02 ? 0 : Math.min(1, s * 1.6)
    this.walkWeight = weight
    w.setEffectiveWeight(weight)
    idle.setEffectiveWeight(1 - weight)
    w.timeScale = cadence * s
  }

  /**
   * Stop every clip and forget the current one, so the next play() starts its clip from scratch.
   * Never call mixer.stopAllAction() on an actor from outside: play() would think the stopped
   * clip still runs and leave him in his bind pose.
   */
  stopAll(): void {
    this.mixer.stopAllAction()
    this.current = null
    this.walkWeight = 0
  }

  /** Total weight of the clips posing him (0 = his bind pose). A clamped Death still counts. */
  poseWeight(): number {
    let w = 0
    for (const a of this.actions.values()) {
      if (posing(a)) {
        w += a.getEffectiveWeight()
      }
    }
    return w
  }

  get walkTime(): number {
    return this.walkAction?.time ?? 0
  }

  stopWalk(fade = 0.2): void {
    if (this.walkAction?.isRunning()) {
      this.walkAction.fadeOut(fade)
    }
    this.walkWeight = 0
    this.idleAction?.setEffectiveWeight(1)
  }

  /**
   * Holsters on the outside of his thighs (measured from his own legs, outside
   * the coat if he wears one), riding the thigh bones. The leather is baked
   * into the body mesh; the gun hangs in a slot on the same bone.
   */
  private placeHolsters(
    f: Fit,
    o: { gun: Object3D; two: boolean; clothes: readonly Piece[]; look: HolsterLook },
  ): Piece[] {
    const { gun, two, clothes, look } = o
    const hips = this.hips
    if (!hips) {
      return []
    }
    const rootQ = this.root.getWorldQuaternion(new Quaternion())
    const hipP = hips.getWorldPosition(new Vector3())
    const out: Piece[] = []
    const mk = (side: 1 | -1): Group => {
      // side 1 = his right (-X while he faces +Z), -1 = his left.
      const bone = this.bone(side === 1 ? 'UpperLegR' : 'UpperLegL') ?? hips
      const bp = bone.getWorldPosition(new Vector3())
      const y = hipP.y - 0.06
      const surface = outerThigh(f, clothes, { side, y, near: bp })
      const q = rootQ
        .clone()
        .multiply(
          new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2 + 0.12 * side),
        )
      if (side === -1) {
        q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI))
      }
      // slot +Y points toward his body on both sides; the barrel sits 0.045 up +Y
      const x = surface - side * (0.026 + 0.045)
      const slot = slotOn(bone, new Vector3(x, y, bp.z + 0.01), q)
      for (const part of holsterParts(look)) {
        slot.add(part)
        out.push(...meshPieces(part, this.root, onBone(bone)))
        part.removeFromParent()
      }
      return slot
    }
    this.holster = mk(1)
    this.gun = mergedProp(gun)
    this.holster.add(this.gun)
    if (two) {
      this.offHolster = mk(-1)
      this.offGun = mergedProp(gun)
      this.offHolster.add(this.offGun)
    }
    return out
  }

  /** Calibrate the grip in the aiming pose so the barrel points down range. */
  private gripGuns(two: boolean): void {
    const hand = this.handR
    if (!hand) {
      return
    }
    const aim = this.actions.get('Idle_Gun_Pointing')
    if (aim) {
      this.mixer.stopAllAction()
      aim.reset().play()
      this.mixer.setTime(0.2)
    }
    this.root.updateMatrixWorld(true)
    const rootQ = this.root.getWorldQuaternion(new Quaternion())
    // Revolver geometry points +X; rotate so it points +Z (character forward).
    const gunQ = rootQ
      .clone()
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2))
    const hp = hand.getWorldPosition(new Vector3())
    const fwd = new Vector3(0, 0, 1).applyQuaternion(rootQ)
    this.handSlot = slotOn(
      hand,
      hp
        .clone()
        .addScaledVector(fwd, 0.02)
        .add(new Vector3(0, -0.01, 0)),
      gunQ,
    )
    if (two && this.handL) {
      const lp = this.handL.getWorldPosition(new Vector3())
      this.offSlot = slotOn(this.handL, lp.clone().addScaledVector(fwd, 0.02), gunQ)
    }
    if (aim) {
      aim.stop()
    }
    this.current = null
    this.play('Idle', 0)
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
  }

  private attachRifle(rifle: Object3D): void {
    const hand = this.handR
    if (!hand) {
      return
    }
    const aim = this.actions.get('Idle_Gun_Pointing')
    if (aim) {
      this.mixer.stopAllAction()
      aim.reset().play()
      this.mixer.setTime(0.2)
    }
    this.root.updateMatrixWorld(true)
    const rootQ = this.root.getWorldQuaternion(new Quaternion())
    const q = rootQ
      .clone()
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2))
    const hp = hand.getWorldPosition(new Vector3())
    const slot = slotOn(hand, hp, q)
    this.rifle = mergedProp(rifle)
    this.rifle.position.set(0, -0.02, 0.1)
    slot.add(this.rifle)
    if (aim) {
      aim.stop()
    }
    this.current = null
    this.play('Idle_Gun_Pointing', 0)
  }

  /** Move the revolver from holster to hand (the draw). */
  draw(): void {
    if (this.gun && this.handSlot && this.gun.parent !== this.handSlot) {
      this.handSlot.add(this.gun)
      this.gun.position.set(0, 0, 0)
      this.gun.rotation.set(0, 0, 0)
    }
    if (this.offGun && this.offSlot && this.offGun.parent !== this.offSlot) {
      this.offSlot.add(this.offGun)
      this.offGun.position.set(0, 0, 0)
      this.offGun.rotation.set(0, 0, 0)
    }
  }

  holsterGun(): void {
    if (this.gun && this.holster && this.gun.parent !== this.holster) {
      this.holster.add(this.gun)
      this.gun.position.set(0, 0, 0)
      this.gun.rotation.set(0, 0, 0)
    }
    if (this.offGun && this.offHolster && this.offGun.parent !== this.offHolster) {
      this.offHolster.add(this.offGun)
      this.offGun.position.set(0, 0, 0)
      this.offGun.rotation.set(0, 0, 0)
    }
  }

  /** Drop the off-hand gun (boss phase 1 wound). */
  dropOffGun(): Object3D | null {
    const g = this.offGun
    if (!g) {
      return null
    }
    g.removeFromParent()
    this.offGun = null
    return g
  }

  /** World position of the muzzle. */
  muzzle(out: Vector3, off = false): Vector3 {
    const g = off ? this.offGun : (this.gun ?? this.rifle)
    if (!g) {
      return this.root.getWorldPosition(out).setY(1.3)
    }
    g.updateWorldMatrix(true, false)
    return out
      .set(this.rifle && !off && !this.gun ? 0.9 : 0.24, 0.045, 0)
      .applyMatrix4(g.matrixWorld)
  }

  headPos(out: Vector3): Vector3 {
    if (this.head) {
      return this.head.getWorldPosition(out)
    }
    return this.root.getWorldPosition(out).setY(1.6)
  }

  /** Detach the hat into world space for physics; returns it. */
  popHat(): Group | null {
    const h = this.hat
    if (!h) {
      return null
    }
    const p = h.getWorldPosition(new Vector3())
    const q = h.getWorldQuaternion(new Quaternion())
    const parent = this.root.parent
    if (!parent) {
      return null
    }
    parent.attach(h)
    h.position.copy(p)
    h.quaternion.copy(q)
    h.scale.setScalar(1)
    this.hat = null
    return h
  }

  update(dt: number): void {
    this.floor.value = this.root.position.y
    this.t += dt
    this.mixer.update(dt)
    // Procedural layers on top of the clip.
    if (this.sway > 0 && this.spine) {
      this.spine.rotation.z += Math.sin(this.t * 1.3) * 0.12 * this.sway
      this.spine.rotation.x += Math.sin(this.t * 0.9 + 1) * 0.06 * this.sway
    }
    if (this.shake > 0 && this.forearmR) {
      this.forearmR.rotation.x += (Math.random() - 0.5) * 0.08 * this.shake
      this.forearmR.rotation.z += (Math.random() - 0.5) * 0.08 * this.shake
    }
    if (this.twitch > 0.001 && this.armR) {
      this.armR.rotation.z += Math.sin(this.t * 40) * 0.12 * this.twitch
      this.armR.rotation.x += 0.15 * this.twitch
      this.twitch = Math.max(0, this.twitch - dt * 3)
    }
  }

  dispose(): void {
    this.disposed = true
    this.mixer.stopAllAction()
    this.root.removeFromParent()
  }
}
