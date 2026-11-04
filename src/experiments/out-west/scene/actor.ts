// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Bone,
  Group,
  LoopOnce,
  LoopRepeat,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { BodyKey, HatKey } from '../data/outlaws.ts'
import { bake, bodyPieces, type Piece } from './bake.ts'
import { DrawLayer } from './draw.ts'
import { type Body, boneKey, bounds, sampleBody } from './fit.ts'
import { hangGuns } from './gunbelt.ts'
import { fitHat, type HatFit, tuckHair } from './hats.ts'
import { type GunAnatomy, handGrip } from './holster.ts'
import { type HolsterLook, mergedProp, PLAIN_HOLSTER } from './kit.ts'
import { fitLong, type LongHold, poseLong, shoulderPocket } from './longgun.ts'
import { type Fit, measure } from './outfit.ts'
import { becomeHimself, type PersonOpts, paintSkin, StanceLayer } from './person.ts'
import { watchPose } from './pose-watch.ts'
import { dressPieces, measureStride, seatHat, slotOn, tintModel } from './rig.ts'
import { characterMaterial, type Glow } from './shade.ts'
import type { Floor } from './style.ts'

const HEIGHT = 1.78
const ORIGIN = new Vector3()

export interface ActorOpts extends PersonOpts {
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
  holster: Group | null = null
  handSlot: Group | null = null
  offSlot: Group | null = null
  offHolster: Group | null = null
  /** The long gun in his hands, if any (scene/longgun.ts). */
  longHeld: LongHold | null = null
  /** Long gun: 0 = shouldered and aimed, 1 = carried at the low ready. */
  longCarry = 0
  /** Long gun recoil, 0..1 (lifts the muzzle). */
  longKick = 0
  /** The hollow of his right shoulder in his chest bone's frame (where a butt plate sits). */
  private readonly pocket: Vector3 | null
  /** The revolver he carries, measured (muzzle, grip, cylinder); null without one. */
  anatomy: GunAnatomy | null = null
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
  /** Emissive pulse on his body and hat, 0..1 (Frontier spawn protection). */
  readonly glow: Glow = { value: 0 }
  private readonly bones = new Map<string, Bone>()
  /** The base carries a sculpted beard (kept by prune when he wears one). */
  private readonly realBeard: boolean
  /** Where his hat sits (null when he has none); the VAT crowd reads it through `hat`. */
  hatFit: HatFit | null = null
  /** Set by dispose() (the dev pose watchdog forgets him). */
  disposed = false
  /** What the dev pose watchdog calls him. */
  readonly label: string
  /** His standing habit, layered on every clip (null: none). */
  private readonly stance: StanceLayer | null = null
  readonly drawing: DrawLayer | null = null

  constructor(gltf: GLTF, opts: ActorOpts = {}) {
    this.label = `${opts.base ?? 'player'} ${opts.seed ?? ''}`.trim()
    this.model = cloneSkinned(gltf.scene)
    // his bones, his own cut, face, torso and proportions, before he is normalised or measured
    this.realBeard = becomeHimself(this.model, this.bones, opts)
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
    const body = this.dress(opts)
    this.pocket = this.measurePocket(body)

    if (this.hatFit && this.head) {
      this.hat = seatHat(
        this.hatFit,
        { color: opts.hatColor ?? 0x3a_2a_1a, floor: this.floor, glow: this.glow },
        { head: this.head, root: this.root },
      )
    }
    if (opts.gun) {
      this.gripGuns(opts.offGun ?? false)
      this.drawing = this.anatomy ? new DrawLayer(this, this.anatomy, (n) => this.bone(n)) : null
    }
    if (opts.rifle) {
      this.attachRifle(opts.rifle)
    }
    this.stance = StanceLayer.of(this.bones, opts.stance)
    watchPose(this)
  }

  /**
   * Dress him in the idle pose, fitted to his own surface, then bake it all into one skinned mesh
   * bound in that pose. Returns the surface he was measured on.
   */
  private dress(opts: ActorOpts): Body {
    const body = sampleBody(this.model, this.root)
    const fit = measure(body, this.bones)
    const clothes = dressPieces(fit, opts, this.root, this.realBeard)
    const pieces = [...bodyPieces(this.model, this.root, body), ...clothes]
    paintSkin(pieces, body, fit.head, opts)
    // the hat is fitted to his skull now, so the hair it covers is pressed under it before baking
    this.hatFit = opts.hat ? fitHat(body, fit.head.eye, opts.hat) : null
    if (this.hatFit) {
      tuckHair(pieces, this.hatFit)
    }
    if (opts.gun) {
      pieces.push(
        ...this.armWith(fit, {
          gun: opts.gun,
          two: opts.offGun ?? false,
          clothes,
          look: opts.holster ?? PLAIN_HOLSTER,
          scale: opts.scale ?? 1,
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
    this.meshes.push(
      bake(pieces, body, this.root, characterMaterial(this.floor, 'Character', this.glow)),
    )
    return body
  }

  /** The hollow of his right shoulder, kept in his chest bone's frame (it rides his chest). */
  private measurePocket(body: Body): Vector3 | null {
    const pocket = shoulderPocket(body, (n) => this.bone(n))
    const chest = this.bone('Chest') ?? this.spine
    return pocket && chest ? chest.worldToLocal(pocket) : null
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
    this.drawing?.onClip(name)
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

  /** Run `fn` with him held in the aiming pose (measuring a grip), then back to idle. */
  private inAimPose<T>(fn: () => T): T {
    const aim = this.actions.get('Idle_Gun_Pointing')
    if (aim) {
      this.mixer.stopAllAction()
      aim.reset().play()
      this.mixer.setTime(0.2)
    }
    this.root.updateMatrixWorld(true)
    const out = fn()
    aim?.stop()
    this.current = null
    this.play('Idle', 0)
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
    return out
  }

  /**
   * The gunbelt and holster(s), fitted to him (scene/holster.ts): the leather is baked into his
   * mesh, each gun hangs on the thigh bone its holster rides, and each hand gets its seat,
   * measured in the aiming pose (the grip in his fist, the barrel down his forearm).
   */
  private armWith(
    f: Fit,
    o: { gun: Object3D; two: boolean; clothes: readonly Piece[]; look: HolsterLook; scale: number },
  ): Piece[] {
    const byName = (n: string) => this.bone(n)
    const hung = hangGuns(f, { ...o, bone: byName, root: this.root })
    if (!hung) {
      return []
    }
    this.anatomy = hung.anatomy
    this.gun = hung.gun
    this.holster = hung.holster
    this.offGun = hung.offGun
    this.offHolster = hung.offHolster
    return hung.pieces
  }

  private gripGuns(two: boolean): void {
    const a = this.anatomy
    const hand = this.handR
    if (!(hand && a)) {
      return
    }
    this.inAimPose(() => {
      const byName = (n: string) => this.bone(n)
      const r = handGrip(byName, 'R', a)
      this.handSlot = r ? slotOn(hand, r.pos, r.quat) : null
      // the off hand's gun lies beside the strong hand's, down range
      const l = two && this.handL ? handGrip(byName, 'L', a, r?.quat) : null
      this.offSlot = l && this.handL ? slotOn(this.handL, l.pos, l.quat) : null
    })
  }

  /** The rooftop rifleman's rifle, shouldered and aimed. */
  private attachRifle(rifle: Object3D): void {
    // the rifle prop lies along Z, muzzle at +Z: turn it down +X like every gun here
    const inner = mergedProp(rifle)
    inner.rotation.y = Math.PI / 2
    const wrap = new Group()
    wrap.add(inner)
    const h = this.addLong(wrap)
    this.rifle = h?.obj ?? null
    this.holdLong(h)
    this.play('Idle_Gun_Pointing', 0)
  }

  /** Fit a long gun (barrel along +X) to him, hidden until `holdLong` (scene/longgun.ts). */
  addLong(obj: Object3D): LongHold | null {
    const chest = this.bone('Chest') ?? this.spine
    const pocket = this.pocket
    if (!(chest && pocket)) {
      return null
    }
    const h = this.inAimPose(() =>
      fitLong(obj, {
        bone: (n) => this.bone(n),
        chest,
        pocket: chest.localToWorld(pocket.clone()),
        rootQ: this.root.getWorldQuaternion(new Quaternion()),
        slotOn,
      }),
    )
    if (h) {
      h.obj.visible = false
    }
    return h
  }

  /** Take a long gun in both hands (null: put it away). */
  holdLong(h: LongHold | null): void {
    if (this.longHeld && this.longHeld !== h) {
      this.longHeld.obj.visible = false
    }
    this.longHeld = h
    if (h) {
      h.obj.visible = true
    }
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
    this.drawing?.reset()
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

  /**
   * Drop the off-hand gun (boss phase 1 wound): it leaves his hand (or holster) where it is,
   * into `into` (the scene) at unit scale, for the physics to toss.
   */
  dropOffGun(into: Object3D): Object3D | null {
    const g = this.offGun
    if (!g) {
      return null
    }
    g.updateWorldMatrix(true, false)
    const p = new Vector3()
    const q = new Quaternion()
    g.matrixWorld.decompose(p, q, new Vector3())
    into.add(g)
    g.position.copy(p)
    g.quaternion.copy(q)
    g.scale.setScalar(1)
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
    if (g === this.rifle && this.longHeld) {
      return out.copy(this.longHeld.a.muzzle).applyMatrix4(g.matrixWorld)
    }
    return out.copy(this.anatomy?.muzzle ?? ORIGIN).applyMatrix4(g.matrixWorld)
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
    this.drawing?.undo()
    this.stance?.undo()
    this.mixer.update(dt)
    this.stance?.apply()
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
    this.drawing?.update(dt)
    if (this.longHeld?.obj.visible) {
      this.root.updateMatrixWorld(true)
      poseLong(this.longHeld, {
        bone: (n) => this.bone(n),
        carry: this.longCarry,
        kick: this.longKick,
        rootQ: this.root.getWorldQuaternion(new Quaternion()),
      })
    }
  }

  dispose(): void {
    this.disposed = true
    this.mixer.stopAllAction()
    this.root.removeFromParent()
  }
}
