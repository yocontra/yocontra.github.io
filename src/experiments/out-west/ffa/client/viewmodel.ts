// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `on` flips through the visible setter; Biome narrows it to its initialiser
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the view model is one rig (its scene, its lights, the gun fits, the arm solve and the flash)
/**
 * The first-person view model, CoD style: your own rider's hands and sleeves on the gun, big and
 * crisp in the lower right, in its own scene drawn over the world through its own camera:
 *
 * - its own field of view (`VM_FOV`, narrower than the world's), so the gun never stretches at a
 *   wide world FOV, and its own lights (the sun turned into the lens's frame, a sky fill and a
 *   soft front fill), so it always reads;
 * - its depth squeezed into the nearest 1% of the depth buffer, so the world never cuts into it
 *   (a wall at arm's length can't swallow the barrel) while the frame's depth stays valid for the
 *   haze;
 * - the gun posed every frame (`vm-motion.ts`: the sights, sway, bob, sprint, jump, recoil,
 *   reload, draw) and both arms solved onto it (two-bone IK): the strong hand on the grip, the
 *   support hand cupping it (the revolver) or under the fore-end (the long guns);
 * - a muzzle flash at the real muzzle, lighting the hands for a frame.
 *
 * Built once per look, and only while first person is on.
 */
import {
  AdditiveBlending,
  type Bone,
  CanvasTexture,
  Color,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../contract/town.ts'
import type { Assets } from '../../engine/assets.ts'
import type { Actor } from '../../scene/actor.ts'
import { castActor } from '../../scene/cast.ts'
import { gunAnatomy, gunPointsOf } from '../../scene/holster.ts'
import { type LongHold, solveArm } from '../../scene/longgun.ts'
import { propDef, propObject } from '../../scene/props.ts'
import { rifleObject } from '../../scene/rifle.ts'
import type { PlayerLook } from '../scene/looks.ts'
import { SupportHand } from '../scene/mirror-hand.ts'
import { kitMaterial, shotgunMesh } from '../scene/shotgun.ts'
import { type VmInput, VmMotion, type VmPose } from './vm-motion.ts'
import { VmSky } from './vm-sky.ts'

/** The view model's own vertical field of view (degrees), and on the sights. */
export const VM_FOV = 54
const VM_FOV_ADS = 46
/** The eye sits this far above and in front of the head bone (m). */
const EYE_UP = 0.09
const EYE_FWD = 0.1
/**
 * His body sits this much further forward and lower than his eye would put it (m): his head is
 * folded away, and it brings his shoulders up behind the gun so his elbows bend like a shooter's.
 */
const BODY_FWD = 0.13
const BODY_DOWN = 0.04
/** A long gun's support hand turns this far under the fore-end from the mirrored grip (rad). */
const FORE_TURN = 0.9
/** Fraction of the depth buffer the view model may use (the nearest slice). */
const DEPTH_SLICE = 0.01

interface Hold {
  /** Where the rear sight sits at the hip, and on the sights (camera space, m). */
  hip: Vector3
  ads: Vector3
  /** At the hip the muzzle turns in toward the crosshair this much (rad), and cants. */
  hipYaw: number
  hipRoll: number
}

const HOLDS: Record<'revolver' | 'rifle' | 'shotgun', Hold> = {
  revolver: {
    hip: new Vector3(0.13, -0.075, -0.26),
    ads: new Vector3(0, -0.004, -0.31),
    hipYaw: 0.26,
    hipRoll: -0.1,
  },
  rifle: {
    hip: new Vector3(0.1, -0.07, -0.46),
    ads: new Vector3(0, -0.012, -0.42),
    hipYaw: 0.12,
    hipRoll: -0.08,
  },
  shotgun: {
    hip: new Vector3(0.1, -0.075, -0.44),
    ads: new Vector3(0, -0.012, -0.4),
    hipYaw: 0.12,
    hipRoll: -0.08,
  },
}

/** A gun in the view model: its object, its sight line, its muzzle, and both wrists on it. */
interface Fit {
  obj: Object3D
  /** Rear sight (gun frame); the line from it to `front` is the sight line. */
  rear: Vector3
  front: Vector3
  muzzle: Vector3
  /** Each wrist in the gun's frame (null: that hand stays off it). */
  right: Matrix4
  left: Matrix4 | null
  /** The revolver: the grip's middle (gun frame); the left hand mirrors the right around it. */
  grip?: Vector3
  /**
   * A long gun: the stock's wrist (where the right fist closes) and the fore-end; the left hand is
   * the right one mirrored, slid up to the fore-end and turned under it.
   */
  stock?: Vector3
  fore?: Vector3
  hold: Hold
}

const tmpV = new Vector3()
const tmpV2 = new Vector3()
const tmpQ = new Quaternion()
const tmpM = new Matrix4()
const tmpM2 = new Matrix4()
const ONE = new Vector3(1, 1, 1)
const euler = new Euler(0, 0, 0, 'YXZ')
/** The gun's +X (barrel) down the lens (−Z), +Y up. */
const BARREL_FWD = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)

function flashTexture(): Texture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')
  if (g) {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    r.addColorStop(0, 'rgba(255,250,220,1)')
    r.addColorStop(0.25, 'rgba(255,200,110,0.9)')
    r.addColorStop(0.6, 'rgba(255,120,40,0.35)')
    r.addColorStop(1, 'rgba(255,90,20,0)')
    g.fillStyle = r
    g.fillRect(0, 0, 64, 64)
  }
  return new CanvasTexture(c)
}

export class ViewModel {
  /** The view model's own scene and lens (drawn by the renderer's overlay pass). */
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(VM_FOV, 1, 0.01, 4)
  private readonly assets: Assets
  private readonly kit: Material
  private readonly rig = new Group()
  private readonly key = new DirectionalLight(0xff_f2_e0, 2.2)
  private readonly fill = new DirectionalLight(0xff_ee_dd, 0.55)
  private readonly sky = new HemisphereLight(0xc8_d8_ff, 0x6b_4e_33, 1.1)
  private readonly flash: Sprite
  private flashT = 1
  private actor: Actor | null = null
  private readonly bones = new Map<string, Bone>()
  private fits: { revolver: Fit | null; rifle: Fit | null; shotgun: Fit | null } = {
    revolver: null,
    rifle: null,
    shotgun: null,
  }
  private held: Fit | null = null
  private support: SupportHand | null = null
  private lookKey = ''
  private pending: PlayerLook | null = null
  readonly motion = new VmMotion()
  /** The town's sky on the guns (their metal reads black without it). */
  readonly townSky = new VmSky()
  private on = false
  private aspect = 1
  private worldFov = 80
  private readonly gunM = new Matrix4()

  constructor(assets: Assets) {
    this.assets = assets
    this.kit = kitMaterial(assets.props)
    this.scene.name = 'viewmodel'
    this.scene.add(this.rig, this.key, this.key.target, this.fill, this.fill.target, this.sky)
    this.fill.position.set(0.3, 0.4, 1)
    this.flash = new Sprite(
      new SpriteMaterial({
        map: flashTexture(),
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
        color: new Color(2.2, 1.8, 1.3),
      }),
    )
    this.flash.visible = false
    this.flash.renderOrder = 10
    this.scene.add(this.flash)
  }

  get visible(): boolean {
    return this.on
  }

  set visible(v: boolean) {
    if (v === this.on) {
      return
    }
    this.on = v
    if (v) {
      this.motion.redraw()
      if (this.pending) {
        this.build(this.pending)
      }
    }
  }

  /** Dress the view model as your rider (built lazily, once first person is on). */
  setLook(look: PlayerLook): void {
    if (look.key === this.lookKey) {
      return
    }
    this.pending = look
    if (this.on) {
      this.build(look)
    }
  }

  /** The world lens's aspect and vertical FOV (for the projection and the muzzle hand-off). */
  setLens(aspect: number, worldFov: number): void {
    this.aspect = aspect
    this.worldFov = worldFov
  }

  /** Bring the gun up from below the frame (spawn, a pickup). */
  redraw(): void {
    this.motion.redraw()
  }

  private build(look: PlayerLook): void {
    if (!this.assets.bodyNow(look.look.base)) {
      this.assets.body(look.look.base).catch(() => undefined)
      return
    }
    this.pending = null
    this.lookKey = look.key
    this.actor?.dispose()
    const def = propDef(this.assets.props, 'revolver', 0.32)
    const gun = def ? propObject(def) : null
    gun?.traverse((o) => {
      if (o instanceof Mesh && !Array.isArray(o.material) && o.material.name === 'Kit') {
        o.material = this.kit
      }
    })
    const actor = castActor(this.assets, {
      look: look.look,
      hat: look.hat,
      hatColor: look.hatColor,
      gun,
    })
    if (actor.hat) {
      actor.hat.visible = false
    }
    if (actor.gun) {
      this.townSky.adopt(actor.gun)
    }
    this.bones.clear()
    actor.root.traverse((o) => {
      o.castShadow = false
      o.receiveShadow = false
      o.frustumCulled = false
      if ((o as Partial<Bone>).isBone === true) {
        this.bones.set(o.name, o as Bone)
      }
    })
    this.rig.add(actor.root)
    actor.root.rotation.y = Math.PI
    actor.draw()
    actor.play('Idle_Gun_Pointing', 0)
    actor.update(0)
    this.rig.updateMatrixWorld(true)
    // his eye on the lens: the head bone, a little up and forward
    const eye = this.rig.worldToLocal(actor.headPos(tmpV))
    actor.root.position.set(-eye.x, -eye.y - EYE_UP - BODY_DOWN, -eye.z + EYE_FWD - BODY_FWD)
    this.rig.updateMatrixWorld(true)
    this.actor = actor
    // the hands' mirror pairs, measured in the bind pose (symmetric: the clip's hands aren't),
    // across his left-right axis (he faces +Z turned to −Z: still the rig's X)
    const skel = actor.meshes[0]?.skeleton
    const saved =
      skel?.bones.map(
        (b) => [b.position.clone(), b.quaternion.clone(), b.scale.clone()] as const,
      ) ?? []
    skel?.pose()
    this.rig.updateMatrixWorld(true)
    this.support = new SupportHand(this.bones, new Vector3(1, 0, 0))
    for (const [k, b] of (skel?.bones ?? []).entries()) {
      const s0 = saved[k]
      if (s0) {
        b.position.copy(s0[0])
        b.quaternion.copy(s0[1])
        b.scale.copy(s0[2])
        b.updateMatrix()
      }
    }
    actor.update(0)
    this.rig.updateMatrixWorld(true)
    this.fits = {
      revolver: actor.gun ? this.fitRevolver(actor, actor.gun) : null,
      rifle: this.fitLong(actor, 'rifle'),
      shotgun: this.fitLong(actor, 'shotgun'),
    }
  }

  /**
   * The revolver in his right hand as the aiming clip holds it; the left hand cups the right
   * (its fist beside and under the grip, parallel to it). Read in the aiming pose.
   */
  private fitRevolver(actor: Actor, gun: Object3D): Fit | null {
    const a = actor.anatomy ?? gunAnatomy(gun)
    const wristR = this.bones.get('WristR')
    if (!wristR) {
      return null
    }
    gun.updateWorldMatrix(true, false)
    const gunW = gun.matrixWorld.clone()
    const right = gunW.clone().invert().multiply(wristR.matrixWorld)
    const top = a.barrel.cy + a.barrel.hy
    return {
      obj: gun,
      rear: new Vector3(a.rearX + 0.03, a.cylinder.cy + a.cylinder.hy + 0.004, 0),
      front: new Vector3(a.muzzle.x - 0.008, top + 0.006, 0),
      muzzle: a.muzzle.clone(),
      right,
      left: null,
      grip: a.grip.clone(),
      hold: HOLDS.revolver,
    }
  }

  /** A long gun: its wrists from the shouldered fit (scene/longgun.ts), re-homed to our frame. */
  private fitLong(actor: Actor, kind: 'shotgun' | 'rifle'): Fit | null {
    const obj = new Group()
    // articulated: the lever and the barrels are child meshes (`lever`, `barrels`) for the reload
    obj.add(kind === 'shotgun' ? shotgunMesh(undefined, true) : rifleObject({ lever: true }))
    this.townSky.adopt(obj)
    const h: LongHold | null = actor.addLong(obj)
    if (!h) {
      return null
    }
    // our own pivot: off his chest, into the rig
    this.rig.add(obj)
    obj.position.set(0, 0, 0)
    obj.quaternion.identity()
    obj.visible = false
    obj.traverse((o) => {
      o.castShadow = false
      o.frustumCulled = false
    })
    // the sight line: the gun's own sights when its builder carries them (the Winchester's notch
    // and blade, the coach gun's rib and bead); else over its two high points, the tallest part
    // ahead of the stock's wrist and the muzzle's top, so on the sights both sit on the crosshair
    // and the rest of the gun drops away below it
    const rear = new Vector3(h.a.wrist.x, -1, 0)
    let frontY = h.a.muzzle.y
    for (const p of h.a.rear ? [] : gunPointsOf(obj)) {
      if (p.x > h.a.wrist.x + 0.02 && p.y > rear.y) {
        rear.set(p.x, p.y, 0)
      }
      if (p.x > h.a.muzzle.x - 0.05) {
        frontY = Math.max(frontY, p.y)
      }
    }
    rear.y += 0.006
    return {
      obj,
      rear: h.a.rear?.clone() ?? rear,
      front: h.a.front?.clone() ?? new Vector3(h.a.muzzle.x, frontY + 0.006, 0),
      muzzle: h.a.muzzle.clone(),
      right: h.right,
      left: null,
      stock: h.a.wrist.clone(),
      fore: h.a.fore.clone(),
      hold: kind === 'shotgun' ? HOLDS.shotgun : HOLDS.rifle,
    }
  }

  /** A shot: the gun kicks and the muzzle flashes. */
  fired(weapon: number): void {
    this.motion.fired(weapon)
    this.flashT = 0
  }

  /**
   * The muzzle in world space, where the world camera would draw it at the spot the view model
   * shows it (for the tracer and the smoke).
   */
  muzzle(world: PerspectiveCamera, out: Vector3): Vector3 {
    const f = this.held
    if (!(f && this.actor)) {
      return out.set(0, -0.1, -0.6).applyMatrix4(world.matrixWorld)
    }
    out.copy(f.muzzle).applyMatrix4(this.gunM)
    const k =
      Math.tan((this.worldFov * Math.PI) / 360) / Math.tan((this.camera.fov * Math.PI) / 360)
    out.x *= k
    out.y *= k
    return out.applyMatrix4(world.matrixWorld)
  }

  /** Per frame: pose the gun and the arms. `sunCam` is the sun's direction in the lens's frame. */
  update(input: VmInput, sunCam: Vector3): void {
    const actor = this.actor
    if (!(this.on && actor)) {
      return
    }
    const pose = this.motion.update(input)
    let fit = this.fits.revolver
    if (input.weapon === WEAPON_SHOTGUN) {
      fit = this.fits.shotgun ?? fit
    } else if (input.weapon === WEAPON_RIFLE) {
      fit = this.fits.rifle ?? fit
    }
    if (fit !== this.held) {
      this.held = fit
      for (const f of [this.fits.rifle, this.fits.shotgun]) {
        if (f) {
          f.obj.visible = f === fit
        }
      }
      if (this.fits.revolver) {
        this.fits.revolver.obj.visible = fit === this.fits.revolver
      }
    }
    actor.play(fit === this.fits.revolver ? 'Idle_Gun_Pointing' : 'Idle_Gun', 0.15)
    actor.longKick = 0
    actor.update(input.dt)
    actor.head?.scale.setScalar(0.001)
    if (!fit) {
      return
    }
    this.placeGun(fit, pose)
    this.rig.updateMatrixWorld(true)
    this.solve(fit, pose)
    this.lens(pose, sunCam, input.dt)
  }

  /** Where the gun goes this frame: the hold (hip → sights) plus the motion, in camera space. */
  private placeGun(fit: Fit, pose: VmPose): void {
    const h = fit.hold
    const ads = pose.ads
    const at = tmpV.copy(h.hip).lerp(h.ads, ads)
    at.x += pose.x
    at.y += pose.y
    at.z += pose.z
    // level the sight line, then the hold's turn and the motion's
    const level = Math.atan2(fit.front.y - fit.rear.y, fit.front.x - fit.rear.x)
    euler.set(pose.pitch, pose.yaw + h.hipYaw * (1 - ads), pose.roll + h.hipRoll * (1 - ads))
    tmpQ.setFromEuler(euler).multiply(BARREL_FWD)
    tmpM.makeRotationZ(-level)
    // gun = T(at) · R(turn) · R(level) · T(−rear)
    this.gunM
      .compose(at, tmpQ, ONE)
      .multiply(tmpM)
      .multiply(tmpM2.makeTranslation(-fit.rear.x, -fit.rear.y, -fit.rear.z))
    if (fit !== this.fits.revolver) {
      fit.obj.matrixAutoUpdate = false
      fit.obj.matrix.copy(this.gunM)
      fit.obj.matrixWorldNeedsUpdate = true
    }
  }

  /** Both arms onto the gun; the revolver then rides the right wrist exactly. */
  private solve(fit: Fit, pose: VmPose): void {
    const b = (n: string) => this.bones.get(n)
    for (const [side, rel, out] of [
      ['R', fit.right, 1],
      ['L', fit.left, -1],
    ] as const) {
      if (side === 'L' && fit.grip) {
        this.supportGrip(fit.grip, pose)
        continue
      }
      if (side === 'L' && fit.stock && fit.fore) {
        this.foreGrip(fit.stock, fit.fore)
        continue
      }
      const upper = b(`UpperArm${side}`)
      const lower = b(`LowerArm${side}`)
      const end = b(`Wrist${side}`)
      if (!(rel && upper && lower && end)) {
        continue
      }
      const t = tmpM.copy(this.gunM).multiply(rel)
      const tp = new Vector3()
      const tq = new Quaternion()
      t.decompose(tp, tq, tmpV2)
      if (side === 'L' && pose.load > 0) {
        // loading: the support hand goes to the gate and back
        tp.x += 0.03 * pose.load
        tp.y += 0.025 * pose.load
        tp.z += 0.02 * pose.load
      }
      // elbows down and out
      const pole = upper.getWorldPosition(new Vector3()).add(tmpV.set(out * 0.35, -0.6, 0.1))
      solveArm({ upper, lower, end }, tp, tq, pole)
    }
  }

  /** The revolver's left hand: the right one mirrored across the gun's side, cupping it. */
  private supportGrip(grip: Vector3, pose: VmPose): void {
    const upper = this.bones.get('UpperArmL')
    const lower = this.bones.get('LowerArmL')
    const end = this.bones.get('WristL')
    const sh = this.support
    if (!(sh && upper && lower && end)) {
      return
    }
    const on = tmpV.copy(grip).applyMatrix4(this.gunM)
    // mirror across the gun's side, kept upright: a rolled gun (the reload) mustn't fling the
    // left hand out to the right
    const n = new Vector3().setFromMatrixColumn(this.gunM, 2).setY(0).normalize()
    const up = new Vector3().setFromMatrixColumn(this.gunM, 1).normalize()
    const fwd = new Vector3().setFromMatrixColumn(this.gunM, 0).normalize()
    const tp = new Vector3()
    const tq = new Quaternion()
    if (!sh.target(on, n, tp, tq)) {
      return
    }
    // a touch lower and forward, so it cups the right fist rather than sharing its grip
    tp.addScaledVector(up, -0.018).addScaledVector(fwd, 0.008)
    if (pose.load > 0) {
      // loading: the support hand goes to the gate and back
      tp.addScaledVector(up, 0.03 * pose.load).addScaledVector(fwd, 0.04 * pose.load)
    }
    const pole = upper.getWorldPosition(new Vector3()).add(tmpV2.set(-0.35, -0.6, 0.1))
    solveArm({ upper, lower, end }, tp, tq, pole)
    sh.fingersLike(n)
  }

  /** A long gun's left hand: the right one mirrored, slid up to the fore-end, turned under it. */
  private foreGrip(stock: Vector3, fore: Vector3): void {
    const upper = this.bones.get('UpperArmL')
    const lower = this.bones.get('LowerArmL')
    const end = this.bones.get('WristL')
    const sh = this.support
    if (!(sh && upper && lower && end)) {
      return
    }
    const on = tmpV.setFromMatrixPosition(this.gunM)
    const n = new Vector3().setFromMatrixColumn(this.gunM, 2).normalize()
    const fwd = new Vector3().setFromMatrixColumn(this.gunM, 0).normalize()
    const tp = new Vector3()
    const tq = new Quaternion()
    if (!sh.target(on, n, tp, tq)) {
      return
    }
    // slide from the stock's wrist to the fore-end (in the gun's frame, turned into ours)
    const d = tmpV2
      .copy(fore)
      .sub(stock)
      .transformDirection(this.gunM)
      .multiplyScalar(fore.distanceTo(stock))
    tp.add(d)
    // turn under the fore-end, about the bore through it
    const pivot = fore.clone().applyMatrix4(this.gunM)
    const turn = tmpQ.setFromAxisAngle(fwd, FORE_TURN)
    tp.sub(pivot).applyQuaternion(turn).add(pivot)
    tq.premultiply(turn)
    const pole = upper.getWorldPosition(new Vector3()).add(tmpV2.set(-0.3, -0.6, 0))
    solveArm({ upper, lower, end }, tp, tq, pole)
    sh.fingersLike(n)
  }

  /** The lens (its FOV eases in on the sights, its depth squeezed), the lights and the flash. */
  private lens(pose: VmPose, sunCam: Vector3, dt: number): void {
    const cam = this.camera
    const fov = VM_FOV + (VM_FOV_ADS - VM_FOV) * pose.ads
    if (cam.fov !== fov || cam.aspect !== this.aspect) {
      cam.fov = fov
      cam.aspect = this.aspect
      cam.updateProjectionMatrix()
      squeezeDepth(cam)
    }
    this.key.position.copy(sunCam).multiplyScalar(2)
    // the flash: a frame or two of light on the hands, the star at the muzzle
    this.flashT += dt
    const f = Math.max(0, 1 - this.flashT / 0.06)
    this.flash.visible = f > 0 && this.held !== null
    if (this.flash.visible && this.held) {
      this.flash.position.copy(this.held.muzzle).applyMatrix4(this.gunM)
      this.flash.position.z -= 0.03
      this.flash.scale.setScalar((0.09 + Math.random() * 0.05) * (0.6 + f * 0.4))
      this.flash.material.rotation = Math.random() * Math.PI
    }
    this.fill.intensity = 0.55 + f * 3
  }

  dispose(): void {
    this.actor?.dispose()
    this.flash.material.map?.dispose()
    this.flash.material.dispose()
  }
}

/**
 * Squeeze a projection's depth into the nearest `DEPTH_SLICE` of the buffer: NDC z' = s·z − (1 − s),
 * so nothing in the world (whose depth only gets that small inside a hand's breadth of the lens)
 * can draw over the gun, and the depth left behind still reads as "right at the lens".
 */
function squeezeDepth(cam: PerspectiveCamera): void {
  const e = cam.projectionMatrix.elements
  const s = DEPTH_SLICE
  for (const col of [0, 4, 8, 12]) {
    e[col + 2] = s * (e[col + 2] ?? 0) - (1 - s) * (e[col + 3] ?? 0)
  }
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert()
}
