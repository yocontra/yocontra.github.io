import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Bone,
  Box3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  LoopOnce,
  LoopRepeat,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector2,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { HatKey, PartSrc } from '../data/outlaws'
import {
  kitbash,
  makeBandoliers,
  makeBeard,
  makeCoat,
  makeMask,
  makeMoustache,
  makePoncho,
  makeStar,
  type PartSlot,
} from './outfit'
import { type Floor, stylize, vary } from './style'

const HEIGHT = 1.78

export interface ActorOpts {
  tint?: Readonly<Record<string, number>>
  hat?: HatKey | null
  hatColor?: number
  bandana?: number | undefined
  /** Revolver geometry to clone into the holster/hand. */
  gun?: Object3D | null
  /** Second gun (two-gun Delmer, Hardin). */
  offGun?: boolean
  rifle?: Object3D | null
  /** Kitbash: head/body/legs/feet from other characters sharing this rig. */
  parts?: Record<PartSlot, { gltf: GLTF; src: PartSrc }> | null
  /** [width, height] build multipliers. */
  build?: readonly [number, number]
  coat?: number | undefined
  poncho?: number | undefined
  moustache?: number | undefined
  beard?: number | undefined
  bandoliers?: boolean | undefined
  star?: boolean | undefined
  mask?: number | undefined
  /** Seed for the subtle per-material colour/roughness variation. */
  seed?: string
}

/** Hat silhouettes from lathe profiles (x = radius, y = height), metres. */
const HAT_PROFILES: Record<HatKey, [number, number][]> = {
  cowboy: [
    [0.0, 0.14],
    [0.06, 0.145],
    [0.085, 0.12],
    [0.1, 0.03],
    [0.12, 0.012],
    [0.17, 0.0],
    [0.205, 0.02],
    [0.215, 0.045],
  ],
  bowler: [
    [0.0, 0.125],
    [0.06, 0.118],
    [0.092, 0.08],
    [0.1, 0.02],
    [0.13, 0.008],
    [0.148, 0.02],
  ],
  sombrero: [
    [0.0, 0.2],
    [0.05, 0.19],
    [0.08, 0.1],
    [0.1, 0.02],
    [0.25, 0.0],
    [0.34, 0.02],
    [0.36, 0.07],
  ],
  tophat: [
    [0.0, 0.2],
    [0.088, 0.2],
    [0.082, 0.1],
    [0.09, 0.012],
    [0.13, 0.0],
    [0.145, 0.018],
  ],
  tall: [
    [0.0, 0.2],
    [0.05, 0.205],
    [0.08, 0.18],
    [0.095, 0.03],
    [0.12, 0.012],
    [0.17, 0.0],
    [0.215, 0.012],
    [0.225, 0.035],
  ],
  flat: [
    [0.0, 0.095],
    [0.095, 0.095],
    [0.1, 0.02],
    [0.13, 0.006],
    [0.185, 0.0],
    [0.19, 0.012],
  ],
}

export function makeHat(key: HatKey, color: number): Group {
  const pts = (HAT_PROFILES[key] ?? HAT_PROFILES.cowboy).map(([x, y]) => new Vector2(x, y))
  // lathe needs the profile ordered bottom→top for outward normals; close the underside
  const prof = [...pts].reverse()
  const g = new Group()
  const felt = new MeshStandardMaterial({ color, roughness: 0.85, side: DoubleSide })
  const crown = new Mesh(new LatheGeometry(prof, 18), felt)
  crown.castShadow = true
  g.add(crown)
  const bandH = key === 'sombrero' ? 0.03 : 0.022
  const r = (HAT_PROFILES[key]?.[2]?.[0] ?? 0.09) + 0.006
  const band = new Mesh(
    new CylinderGeometry(r, r + 0.004, bandH, 18, 1, true),
    new MeshStandardMaterial({
      color: new Color(color).multiplyScalar(0.35),
      roughness: 0.6,
      side: DoubleSide,
    }),
  )
  band.position.y = 0.03
  g.add(band)
  // Crumple the brim a touch so it doesn't read as CG-perfect.
  g.rotation.z = (Math.random() - 0.5) * 0.06
  return g
}

function findBone(root: Object3D, name: string): Bone | null {
  const clean = name.replace(/[.\s]/g, '')
  let found: Bone | null = null
  root.traverse((o) => {
    if (found) return
    const b = o as Bone
    if (b.isBone && b.name.replace(/[.\s]/g, '').replace(/_\d+$/, '') === clean) found = b
  })
  return found
}

const tmpV = new Vector3()
const V3 = (x: number, y: number, z: number) => new Vector3(x, y, z)
const tmpQ = new Quaternion()
const tmpQ2 = new Quaternion()

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
  /** World-space offset from the head bone to the crown, for physics hand-off. */
  gun: Object3D | null = null
  offGun: Object3D | null = null
  rifle: Object3D | null = null
  private holster: Group | null = null
  private handSlot: Group | null = null
  private offSlot: Group | null = null
  private offHolster: Group | null = null
  readonly meshes: SkinnedMesh[] = []
  /** Distance travelled per pace at full stride (measured from the walk clip). */
  paceLength = 0.75
  /** Walk clip time of each heel strike. */
  heelStrikes: number[] = [0, 0.66]
  walkDuration = 1.33
  private walkAction: AnimationAction | null = null
  private idleAction: AnimationAction | null = null
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

  constructor(gltf: GLTF, opts: ActorOpts = {}) {
    this.model = cloneSkinned(gltf.scene)
    if (opts.parts) kitbash(this.model, opts.parts)
    // Scale to a consistent height, then apply his build.
    this.model.updateMatrixWorld(true)
    const box = new Box3().setFromObject(this.model)
    const h = box.max.y - box.min.y
    const [bw, bh] = opts.build ?? [1, 1]
    const k = HEIGHT / Math.max(0.01, h)
    this.model.scale.multiplyScalar(k)
    this.model.scale.x *= bw
    this.model.scale.z *= bw
    this.model.scale.y *= bh
    this.model.position.y = -box.min.y * k * bh
    this.root.add(this.model)
    this.height = HEIGHT * bh

    const tint = opts.tint ?? {}
    const matCache = new Map<Material, Material>()
    const seed = opts.seed ?? 'player'
    this.model.traverse((o) => {
      const m = o as SkinnedMesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      m.frustumCulled = false
      if ((m as SkinnedMesh).isSkinnedMesh) this.meshes.push(m)
      const swap = (src: Material): Material => {
        const cached = matCache.get(src)
        if (cached) return cached
        const c = src.clone() as MeshStandardMaterial
        const hex = tint[src.name]
        if (hex !== undefined) c.color.setHex(hex)
        vary(c, seed)
        matCache.set(src, c)
        return c
      }
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
    })

    this.head = findBone(this.model, 'Head')
    this.handR = findBone(this.model, 'Wrist.R') ?? findBone(this.model, 'Fist.R')
    this.handL = findBone(this.model, 'Wrist.L') ?? findBone(this.model, 'Fist.L')
    this.hips = findBone(this.model, 'Hips')
    this.spine = findBone(this.model, 'Torso') ?? findBone(this.model, 'Abdomen')
    this.armR = findBone(this.model, 'UpperArm.R')
    this.forearmR = findBone(this.model, 'LowerArm.R')

    this.mixer = new AnimationMixer(this.model)
    for (const clip of gltf.animations) {
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

    if (opts.hat) this.attachHat(makeHat(opts.hat, opts.hatColor ?? 0x3a2a1a))
    if (opts.bandana !== undefined) this.attachBandana(opts.bandana)
    this.dress(opts)
    // Clean stylized shading on everything he wears (guns keep their own look).
    this.root.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const sm = mat as MeshStandardMaterial
        if (sm.isMeshStandardMaterial) stylize(sm, this.floor)
      }
    })
    if (opts.gun) this.attachGuns(opts.gun, opts.offGun ?? false)
    if (opts.rifle) this.attachRifle(opts.rifle)
  }

  /** Accessories that make each outlaw a silhouette of his own. */
  private dress(o: ActorOpts): void {
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
    const rootQ = this.root.getWorldQuaternion(new Quaternion())
    const w = o.build?.[0] ?? 1
    const hips = this.hips
    const chest = findBone(this.model, 'Chest') ?? this.spine
    const neck = findBone(this.model, 'Neck')
    if (o.coat !== undefined && hips) {
      const p = hips.getWorldPosition(new Vector3())
      const coat = makeCoat(o.coat)
      coat.scale.set(w, 1, w)
      this.slotOn(hips, p, rootQ).add(coat)
    }
    if (o.poncho !== undefined && neck) {
      const p = neck.getWorldPosition(new Vector3()).add(new Vector3(0, 0.02, 0))
      const poncho = makePoncho(o.poncho)
      poncho.scale.set(w, 1, w)
      this.slotOn(chest ?? neck, p, rootQ).add(poncho)
    }
    if (chest && (o.bandoliers || o.star)) {
      const p = chest.getWorldPosition(new Vector3())
      const slot = this.slotOn(chest, p, rootQ)
      if (o.bandoliers) {
        const b = makeBandoliers()
        b.scale.set(w, 1, w)
        slot.add(b)
      }
      if (o.star) {
        const st = makeStar()
        st.position.set(0.1 * w, 0.06, 0.135 * w)
        slot.add(st)
      }
    }
    // Facial hair and masks: placed from the head mesh's bounds.
    const head = this.head
    const headMesh = this.meshes.find((m) => m.userData['slot'] === 'head') ?? null
    if (head && (o.moustache !== undefined || o.beard !== undefined || o.mask !== undefined)) {
      const hb = headMesh ? new Box3().setFromObject(headMesh) : null
      const hp = head.getWorldPosition(new Vector3())
      const top = hb ? hb.max.y : hp.y + 0.25
      const front = hb ? hb.max.z : hp.z + 0.1
      const hh = hb ? hb.max.y - hb.min.y : 0.3
      const chin = top - hh * 0.92
      if (o.moustache !== undefined) {
        const m = makeMoustache(o.moustache)
        this.slotOn(head, new Vector3(hp.x, chin + hh * 0.3, front - 0.012), rootQ).add(m)
      }
      if (o.beard !== undefined) {
        const b = makeBeard(o.beard)
        this.slotOn(head, new Vector3(hp.x, chin + hh * 0.22, front - 0.06), rootQ).add(b)
      }
      if (o.mask !== undefined) {
        const m = makeMask(o.mask)
        this.slotOn(head, new Vector3(hp.x, chin + hh * 0.26, front - 0.1), rootQ).add(m)
      }
    }
  }

  /** Sample the walk clip to find stride length and heel-strike times (no foot sliding). */
  private measureWalk(clip: AnimationClip): void {
    const footL = findBone(this.model, 'Foot.L')
    const footR = findBone(this.model, 'Foot.R')
    if (!footL || !footR) return
    const action = this.mixer.clipAction(clip)
    action.reset().play()
    action.weight = 1
    const n = 48
    const zl: number[] = []
    const zr: number[] = []
    const inv = this.root.matrixWorld.clone().invert()
    for (let i = 0; i < n; i++) {
      this.mixer.setTime((i / n) * clip.duration)
      this.root.updateMatrixWorld(true)
      inv.copy(this.root.matrixWorld).invert()
      zl.push(footL.getWorldPosition(tmpV).applyMatrix4(inv).z)
      zr.push(footR.getWorldPosition(tmpV).applyMatrix4(inv).z)
    }
    action.stop()
    const range = (a: number[]) => Math.max(...a) - Math.min(...a)
    const stride = (range(zl) + range(zr)) / 2
    if (stride > 0.2 && stride < 1.5) this.paceLength = stride
    const argmax = (a: number[]) => a.indexOf(Math.max(...a))
    this.heelStrikes = [(argmax(zl) / n) * clip.duration, (argmax(zr) / n) * clip.duration].sort(
      (a, b) => a - b,
    )
  }

  action(name: Clip): AnimationAction | null {
    return this.actions.get(name) ?? null
  }

  /** Crossfade to a clip. */
  play(name: Clip, fade = 0.2, once = false, timeScale = 1): AnimationAction | null {
    const a = this.actions.get(name)
    if (!a) return null
    if (this.current === a && !once) return a
    a.enabled = true
    a.reset()
    a.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity)
    a.clampWhenFinished = once
    a.timeScale = timeScale
    a.setEffectiveWeight(1)
    a.play()
    if (this.current && this.current !== a) {
      if (fade > 0) this.current.crossFadeTo(a, fade, false)
      else this.current.stop()
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
    if (!w || !idle) return
    if (this.current !== idle) {
      this.play('Idle', 0.15)
    }
    if (!w.isRunning()) {
      w.reset().play()
      w.setLoop(LoopRepeat, Infinity)
    }
    const s = Math.min(1, Math.max(0, speed))
    const weight = s < 0.02 ? 0 : Math.min(1, s * 1.6)
    this.walkWeight = weight
    w.setEffectiveWeight(weight)
    idle.setEffectiveWeight(1 - weight)
    w.timeScale = cadence * s
  }

  get walkTime(): number {
    return this.walkAction?.time ?? 0
  }

  stopWalk(fade = 0.2): void {
    if (this.walkAction?.isRunning()) this.walkAction.fadeOut(fade)
    this.walkWeight = 0
    this.idleAction?.setEffectiveWeight(1)
  }

  private attachHat(hat: Group): void {
    const head = this.head
    if (!head) return
    this.root.updateMatrixWorld(true)
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
    // World top of the head: highest vertex near the head bone ≈ model bbox top.
    const top = new Box3().setFromObject(this.model).max.y
    const hp = head.getWorldPosition(new Vector3())
    const slot = new Group()
    head.add(slot)
    const inv = head.matrixWorld.clone().invert()
    const target = new Vector3(hp.x, top - 0.085, hp.z + 0.01)
    slot.position.copy(target.applyMatrix4(inv))
    head.getWorldQuaternion(tmpQ)
    this.root.getWorldQuaternion(tmpQ2)
    slot.quaternion.copy(tmpQ.invert().multiply(tmpQ2))
    const ws = head.getWorldScale(new Vector3())
    slot.scale.setScalar(1 / ws.x)
    slot.add(hat)
    hat.rotation.x = -0.08
    this.hat = hat
  }

  private attachBandana(color: number): void {
    const neck = findBone(this.model, 'Neck')
    if (!neck) return
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
    const slot = new Group()
    neck.add(slot)
    const ws = neck.getWorldScale(new Vector3())
    slot.scale.setScalar(1 / ws.x)
    neck.getWorldQuaternion(tmpQ)
    this.root.getWorldQuaternion(tmpQ2)
    slot.quaternion.copy(tmpQ.invert().multiply(tmpQ2))
    const mat = new MeshStandardMaterial({ color, roughness: 0.9, side: DoubleSide })
    const ring = new Mesh(new CylinderGeometry(0.075, 0.1, 0.07, 12, 1, true), mat)
    ring.position.set(0, 0.02, 0.01)
    const tri = new Mesh(new CylinderGeometry(0.0, 0.08, 0.12, 3, 1), mat)
    tri.rotation.x = Math.PI
    tri.scale.set(1, 1, 0.35)
    tri.position.set(0, -0.03, 0.085)
    slot.add(ring, tri)
  }

  /** Make a bone-local slot that holds world-space-authored children (unit scale, root orientation). */
  private slotOn(bone: Bone, worldPos: Vector3, worldQuat: Quaternion): Group {
    const slot = new Group()
    bone.add(slot)
    bone.updateMatrixWorld(true)
    const inv = bone.matrixWorld.clone().invert()
    slot.position.copy(worldPos.clone().applyMatrix4(inv))
    bone.getWorldQuaternion(tmpQ)
    slot.quaternion.copy(tmpQ.clone().invert().multiply(worldQuat))
    const ws = bone.getWorldScale(new Vector3())
    slot.scale.setScalar(1 / ws.x)
    return slot
  }

  private attachGuns(gun: Object3D, two: boolean): void {
    const hand = this.handR
    const hips = this.hips
    if (!hand || !hips) return
    // Calibrate the grip in the aiming pose so the barrel points down range.
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
    this.handSlot = this.slotOn(
      hand,
      hp
        .clone()
        .addScaledVector(fwd, 0.02)
        .add(new Vector3(0, -0.01, 0)),
      gunQ,
    )
    if (two && this.handL) {
      const lp = this.handL.getWorldPosition(new Vector3())
      this.offSlot = this.slotOn(this.handL, lp.clone().addScaledVector(fwd, 0.02), gunQ)
    }
    if (aim) aim.stop()
    this.current = null
    this.play('Idle', 0)
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
    // Holsters ride on the thighs, flush with the outside of the trousers
    // (measured from his legs mesh, so wide builds don't leave them floating).
    const hipP = hips.getWorldPosition(new Vector3())
    const legs =
      this.meshes.find((m) => m.userData['slot'] === 'legs') ??
      this.meshes.find(
        (m) => /_(Pants|Legs)$/.test(m.name) || /_(Pants|Legs)$/.test(m.parent?.name ?? ''),
      ) ??
      null
    const lb = legs
      ? new Box3().setFromObject(legs)
      : new Box3(V3(hipP.x - 0.17, 0, 0), V3(hipP.x + 0.17, 1, 0))
    const mkHolster = (side: 1 | -1): Group => {
      // side 1 = his right (-X while he faces +Z), -1 = his left.
      const bone = findBone(this.model, side === 1 ? 'UpperLeg.R' : 'UpperLeg.L') ?? hips
      const bp = bone.getWorldPosition(new Vector3())
      const surface = side === 1 ? lb.min.x : lb.max.x
      const q = rootQ
        .clone()
        .multiply(
          new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2 + 0.12 * side),
        )
      if (side === -1) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI))
      // slot +Y points toward his body on both sides; the barrel sits 0.045 up +Y
      const x = surface - side * (0.028 + 0.045)
      const slot = this.slotOn(bone, new Vector3(x, hipP.y - 0.06, bp.z + 0.01), q)
      const leather = new Mesh(
        new CylinderGeometry(0.03, 0.026, 0.2, 7),
        new MeshStandardMaterial({ color: 0x3a2414, roughness: 0.7 }),
      )
      leather.rotation.z = Math.PI / 2
      leather.position.set(0.13, 0.045, 0)
      leather.castShadow = true
      slot.add(leather)
      return slot
    }
    this.holster = mkHolster(1)
    this.gun = gun.clone()
    this.holster.add(this.gun)
    if (two) {
      this.offHolster = mkHolster(-1)
      this.offGun = gun.clone()
      this.offHolster.add(this.offGun)
    }
  }

  private attachRifle(rifle: Object3D): void {
    const hand = this.handR
    if (!hand) return
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
    const slot = this.slotOn(hand, hp, q)
    this.rifle = rifle.clone()
    this.rifle.position.set(0, -0.02, 0.1)
    slot.add(this.rifle)
    if (aim) aim.stop()
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
    if (!g) return null
    g.removeFromParent()
    this.offGun = null
    return g
  }

  /** World position of the muzzle. */
  muzzle(out: Vector3, off = false): Vector3 {
    const g = off ? this.offGun : (this.gun ?? this.rifle)
    if (!g) return this.root.getWorldPosition(out).setY(1.3)
    g.updateWorldMatrix(true, false)
    return out
      .set(this.rifle && !off && !this.gun ? 0.9 : 0.24, 0.045, 0)
      .applyMatrix4(g.matrixWorld)
  }

  headPos(out: Vector3): Vector3 {
    if (this.head) return this.head.getWorldPosition(out)
    return this.root.getWorldPosition(out).setY(1.6)
  }

  /** Detach the hat into world space for physics; returns it. */
  popHat(): Group | null {
    const h = this.hat
    if (!h) return null
    const p = h.getWorldPosition(new Vector3())
    const q = h.getWorldQuaternion(new Quaternion())
    const parent = this.root.parent
    if (!parent) return null
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
    this.mixer.stopAllAction()
    this.root.removeFromParent()
  }
}
