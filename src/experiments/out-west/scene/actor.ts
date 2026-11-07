// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import {
  type AnimationAction,
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
import { dressActor, measureActorWalk } from './actor-dress.ts'
import { type ActorOpts, actorClips, actorLabel } from './actor-options.ts'
import { type ActorTemplate, forkPlayback, forkTemplate, snapshotActor } from './actor-template.ts'
import { PROBE, probeIdle, probeRest } from './anim-probe.ts'
import type { Piece } from './bake.ts'
import { type Clip, clipPoseWeight, posing } from './clips.ts'
import { DrawLayer } from './draw.ts'
import { type Body, boneKey, bounds, sampleBody } from './fit.ts'
import { GestureLayer } from './gesture.ts'
import { hangGuns } from './gunbelt.ts'
import type { HatFit } from './hats.ts'
import { type GunAnatomy, handGrip } from './holster.ts'
import { type HolsterLook, PLAIN_HOLSTER } from './kit.ts'
import { fitLong, type LongHold, poseLong, shoulderPocket } from './longgun.ts'
import { nudge } from './nudge.ts'
import type { Fit } from './outfit.ts'
import { becomeHimself, StanceLayer } from './person.ts'
import { watchPose } from './pose-watch.ts'
import { tickGuns } from './revolver.ts'
import { hatStyle, retireRig, seatHat, seatProp, slotOn, tintModel } from './rig.ts'
import { characterMaterial, type Glow } from './shade.ts'
import type { Floor } from './style.ts'

const HEIGHT = 1.78
const ORIGIN = new Vector3()

export type { ActorOpts } from './actor-options.ts'

export type { Clip } from './clips.ts'

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
  /** A procedural layer run after the clips, before the long-gun IK (Frontier's locomotion). */
  layer: (() => void) | null = null
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
  /** The current clip's name (gestures stand down under anything but his idle). */
  private currentName = 'Idle'
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
  private readonly neutralFrames: NonNullable<Body['neutralFrames']>
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
  /** His small habits on the idle and walk: fidgets, the hat tip, the talker's hand (scene/gesture.ts). */
  readonly gestures: GestureLayer
  /** The rooftop rifleman's rifle kick decays on its own (Frontier drives `longKick` itself). */
  private kickDecays = false
  private readonly stanceSpec: ActorOpts['stance']

  constructor(gltf: GLTF | ActorTemplate, opts: ActorOpts = {}) {
    if ('prepared' in gltf) {
      const fork = forkTemplate(gltf, this.floor, this.glow)
      this.root = fork.root
      this.model = fork.model
      this.label = gltf.label
      this.realBeard = gltf.realBeard
      this.neutralFrames = gltf.neutralFrames
      this.stanceSpec = gltf.stance
      this.height = gltf.height
      this.paceLength = gltf.paceLength
      this.heelStrikes = [...gltf.heelStrikes]
      this.walkDuration = gltf.walkDuration
      this.pocket = fork.pocket
      this.anatomy = fork.anatomy
      this.hatFit = fork.hatFit
      for (const [name, bone] of fork.bones) {
        this.bones.set(name, bone)
      }
      this.head = fork.head
      this.handR = fork.handR
      this.handL = fork.handL
      this.hips = fork.hips
      this.spine = fork.spine
      this.armR = fork.armR
      this.forearmR = fork.forearmR
      this.hat = fork.hat
      this.gun = fork.gun
      this.offGun = fork.offGun
      this.holster = fork.holster
      this.handSlot = fork.handSlot
      this.offSlot = fork.offSlot
      this.offHolster = fork.offHolster
      this.meshes.push(...fork.meshes)
      const playback = forkPlayback(gltf, this.model)
      this.mixer = playback.mixer
      this.actions = playback.actions
      this.walkAction = playback.walkAction
      this.idleAction = playback.idleAction
      this.drawing = this.anatomy ? new DrawLayer(this, this.anatomy, (n) => this.bone(n)) : null
      this.stance = StanceLayer.of(this.bones, this.stanceSpec)
      this.gestures = new GestureLayer((n) => this.bone(n), this.root)
      this.play('Idle', 0)
      this.mixer.update(0)
      this.root.updateMatrixWorld(true)
      watchPose(this)
      return
    }
    this.label = actorLabel(opts)
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

    const neutralSpace = this.root.matrixWorld.clone().invert()
    this.neutralFrames = [...this.bones].map(([key, bone]) => ({
      key,
      matrix: neutralSpace.clone().multiply(bone.matrixWorld).toArray(),
    }))
    this.mixer = new AnimationMixer(this.model)
    if (PROBE) {
      probeRest(this, this.bones, this.mixer)
    }
    const clips = actorClips(gltf, opts)
    this.stanceSpec = opts.stance
    for (const clip of clips) {
      const name = clip.name.split('|').pop() ?? clip.name
      this.actions.set(name, this.mixer.clipAction(clip))
    }
    this.walkAction = this.actions.get('Walk') ?? null
    this.idleAction = this.actions.get('Idle') ?? null
    if (this.walkAction) {
      this.walkDuration = this.walkAction.getClip().duration
      measureActorWalk(this, this.walkAction.getClip(), this.bones)
    }
    this.play('Idle', 0)
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
    if (PROBE) {
      probeIdle(this)
    }

    tintModel(this.model, opts)
    const body = this.dress(opts)
    this.pocket = this.measurePocket(body)

    if (this.hatFit && this.head) {
      this.hat = seatHat(this.hatFit, hatStyle(opts, this.floor, this.glow), {
        head: this.head,
        root: this.root,
      })
    }
    if (opts.gun) {
      this.gripGuns(opts.offGun ?? false)
      this.drawing = this.anatomy ? new DrawLayer(this, this.anatomy, (n) => this.bone(n)) : null
    }
    if (opts.rifle) {
      this.attachRifle(opts.rifle)
    }
    this.stance = StanceLayer.of(this.bones, opts.stance)
    this.gestures = new GestureLayer((n) => this.bone(n), this.root)
    watchPose(this)
  }

  /** Freeze fitted geometry and attachment seats before any mutable corpse staging. */
  template(): ActorTemplate {
    return snapshotActor(
      this,
      {
        clips: [...this.actions.values()].map((action) => action.getClip()),
        realBeard: this.realBeard,
        neutralFrames: this.neutralFrames,
        pocket: this.pocket,
        stance: this.stanceSpec,
      },
      this.bones,
    )
  }

  /**
   * Dress him in the idle pose, fitted to his own surface, then bake it all into one skinned mesh
   * bound in that pose. Returns the surface he was measured on.
   */
  private dress(opts: ActorOpts): Body {
    const dressed = dressActor(this.model, this.root, opts, {
      neutralFrames: this.neutralFrames,
      realBeard: this.realBeard,
      bones: this.bones,
      material: characterMaterial(this.floor, 'Character', this.glow),
      armWith: (fit, clothes, gun) =>
        this.armWith(fit, {
          gun,
          two: opts.offGun ?? false,
          clothes,
          look: opts.holster ?? PLAIN_HOLSTER,
          scale: opts.scale ?? 1,
        }),
    })
    this.hatFit = dressed.hatFit
    this.meshes.push(dressed.mesh)
    return dressed.body
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

  /** The rifle kicks (the rooftop rifleman's shot); it settles on its own. */
  kickLong(): void {
    this.longKick = 1
    this.kickDecays = true
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
    this.currentName = name
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
  stopAll(resetStance = false): void {
    if (resetStance) {
      this.stance?.undo()
    }
    this.mixer.stopAllAction()
    this.current = null
    this.walkWeight = 0
  }

  /** Total weight of the clips posing him (0 = his bind pose). A clamped Death still counts. */
  poseWeight(): number {
    return clipPoseWeight(this.actions.values())
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

  /** The rooftop rifleman's rifle (barrel along +X, scene/rifle.ts), shouldered and aimed. */
  private attachRifle(rifle: Object3D): void {
    const wrap = new Group()
    wrap.add(rifle)
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
    seatProp(this.gun, this.handSlot)
    seatProp(this.offGun, this.offSlot)
  }

  holsterGun(): void {
    this.drawing?.reset()
    seatProp(this.gun, this.holster)
    seatProp(this.offGun, this.offHolster)
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
    return this.head ? this.head.getWorldPosition(out) : this.root.getWorldPosition(out).setY(1.6)
  }

  /** Detach the hat into world space for physics; returns it. */
  popHat(): Group | null {
    const h = this.hat
    if (!h) {
      return null
    }
    const p = h.getWorldPosition(new Vector3())
    const q = h.getWorldQuaternion(new Quaternion())
    const slot = h.parent
    const parent = this.root.parent
    if (!parent) {
      return null
    }
    parent.attach(h)
    h.position.copy(p)
    h.quaternion.copy(q)
    h.scale.setScalar(1)
    if (slot && slot.children.length === 0) {
      slot.removeFromParent()
    }
    this.hat = null
    return h
  }

  update(dt: number): void {
    this.floor.value = this.root.position.y
    this.t += dt
    this.drawing?.undo()
    this.gestures.undo()
    this.stance?.undo()
    this.mixer.update(dt)
    this.stance?.apply()
    this.layer?.()
    // the draw, or a clip that isn't his idle (a shot, a hit, a death), owns him
    const idle = this.currentName === 'Idle' || this.currentName === 'Idle_Neutral'
    this.gestures.apply(dt, Boolean(this.drawing?.active) || !idle)
    // the drunk's sway, the shaky hand, a twitch (scene/nudge.ts)
    this.kickDecays = nudge(this, this.t, dt, this.kickDecays)
    this.drawing?.update(dt)
    tickGuns(this, dt)
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
    retireRig(this.mixer, this.root, this.meshes)
  }
}
