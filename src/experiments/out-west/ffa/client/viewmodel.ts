// biome-ignore-all lint/complexity/useMaxParams: the per-frame update takes positional numbers
/**
 * The first-person view model: your own rider, the same skinned character the others see over
 * your shoulder (his shirt, his skin, the atlas and its lighting), parented to the camera with his
 * eye on the lens and his head folded away. He holds the gun the way he holds it in third person
 * (`Idle_Gun_Pointing` for the revolver, the two-handed long-gun hold for the rifle and the coach
 * gun), so the arm, the cuff and the hand on the grip are his own.
 *
 * On top: sway against the look, a bob with the stride, a kick on every shot (the forearm for the
 * revolver, the shoulder for a long gun), a dip while reloading, the sights brought up to the
 * crosshair when you aim, and a pull back off a wall instead of poking through it. Never casts
 * shadows. Built once per look, and only once first person is on.
 */
import {
  type Camera,
  Group,
  type Material,
  MathUtils,
  Mesh,
  type PerspectiveCamera,
  Vector3,
} from 'three'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../contract/town.ts'
import type { Assets } from '../../engine/assets.ts'
import type { Actor } from '../../scene/actor.ts'
import { castActor } from '../../scene/cast.ts'
import type { LongHold } from '../../scene/longgun.ts'
import { propDef, propObject } from '../../scene/props.ts'
import type { PlayerLook } from '../scene/looks.ts'
import { kitMaterial, shotgunMesh } from '../scene/shotgun.ts'

/** The eye sits this far above and in front of the head bone (m). */
const EYE_UP = 0.09
const EYE_FWD = 0.11
/**
 * Where the muzzle rests in camera space at the hip (right of centre, below the crosshair, so the
 * forearm and the hand on the grip are in view), and how far the whole hold moves in depth at
 * the hip and on the sights.
 */
const HIP = new Vector3(0.15, -0.11, 0)
const HIP_Z = 0.02
/** A shouldered long gun on the sights: the stock comes in and up toward the eye (m). */
const LONG_ADS = { x: 0.07, y: 0.05 }
const ADS_Z = -0.06
/** Height of the sight line above the muzzle's centre, so the crosshair rests on the sights. */
const SIGHT = 0.028
const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const tmp = new Vector3()
const muz = new Vector3()

export class ViewModel {
  readonly root = new Group()
  /** The actor's frame: the eye at its origin, moved by the sway, the bob and the sights. */
  private readonly holder = new Group()
  private readonly camera: PerspectiveCamera
  private readonly assets: Assets
  private readonly kit: Material
  private actor: Actor | null = null
  private long: { shotgun: LongHold | null; rifle: LongHold | null } = {
    shotgun: null,
    rifle: null,
  }
  private lookKey = ''
  private pending: PlayerLook | null = null
  private kick = 0
  private swayX = 0
  private swayY = 0
  private bob = 0
  private bobAmp = 0
  private reload = 0
  private push = 0
  /** Where the muzzle sits (camera space) without the aim offset, smoothed. */
  private readonly sight = new Vector3(0.1, -0.12, -0.4)

  constructor(camera: Camera, assets: Assets) {
    this.camera = camera as PerspectiveCamera
    this.assets = assets
    this.kit = kitMaterial(assets.props)
    this.root.name = 'viewmodel'
    this.root.visible = false
    this.root.add(this.holder)
    camera.add(this.root)
  }

  get visible(): boolean {
    return this.root.visible
  }

  set visible(v: boolean) {
    this.root.visible = v
    if (v && this.pending) {
      this.build(this.pending)
    }
  }

  /** Dress the view model as your rider (built lazily, once first person is on). */
  setLook(look: PlayerLook): void {
    if (look.key === this.lookKey) {
      return
    }
    this.pending = look
    if (this.root.visible) {
      this.build(look)
    }
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
    this.long = { shotgun: this.longGun(actor, 'shotgun'), rifle: this.longGun(actor, 'rifle') }
    actor.draw()
    actor.play('Idle_Gun_Pointing', 0)
    actor.update(0)
    // he faces +Z; the lens looks down −Z
    actor.root.rotation.y = Math.PI
    actor.root.position.set(0, 0, 0)
    this.holder.position.set(0, 0, 0)
    this.holder.add(actor.root)
    actor.root.traverse((o) => {
      o.castShadow = false
      o.frustumCulled = false
    })
    // his eye on the lens: the head bone, a little up and forward, in the holder's frame
    this.holder.updateMatrixWorld(true)
    const eye = this.holder.worldToLocal(actor.headPos(tmp))
    actor.root.position.set(-eye.x, -eye.y - EYE_UP, -eye.z + EYE_FWD)
    this.actor = actor
  }

  private longGun(actor: Actor, kind: 'shotgun' | 'rifle'): LongHold | null {
    const obj = new Group()
    if (kind === 'shotgun') {
      obj.add(shotgunMesh(this.kit))
    } else {
      const def = propDef(this.assets.props, 'rifle', 1.1)
      if (!def) {
        return null
      }
      const inner = propObject(def)
      // the rifle prop lies along Z, muzzle at +Z; turn it down +X like every gun here
      inner.rotation.y = Math.PI / 2
      obj.add(inner)
    }
    return actor.addLong(obj)
  }

  /** A shot: the gun kicks. */
  fired(): void {
    this.kick = 1
  }

  /** The muzzle in world space (for the tracer and the flash). */
  muzzle(out: Vector3): Vector3 {
    if (!this.actor) {
      return out.set(0, 0, -0.5).applyMatrix4(this.root.matrixWorld)
    }
    this.actor.root.updateWorldMatrix(true, true)
    return muzzleOf(this.actor, out)
  }

  /**
   * Per frame: `lookYaw`/`lookPitch` this frame's look turn (rad), `speed` your planar speed,
   * `ads` the sights blend 0..1, `reloading` while the reload runs, `wall` the distance to a wall
   * ahead (m).
   */
  update(
    dt: number,
    weapon: number,
    lookYaw: number,
    lookPitch: number,
    speed: number,
    ads: number,
    reloading: boolean,
    wall: number,
  ): void {
    const actor = this.actor
    if (!(this.root.visible && actor)) {
      return
    }
    let held: LongHold | null = null
    if (weapon === WEAPON_SHOTGUN) {
      held = this.long.shotgun
    } else if (weapon === WEAPON_RIFLE) {
      held = this.long.rifle
    }
    if (held) {
      actor.holsterGun()
    } else {
      actor.draw()
    }
    actor.holdLong(held)
    actor.longCarry = 0
    actor.play(held ? 'Idle_Gun' : 'Idle_Gun_Pointing', 0.15)
    const e = (rate: number) => 1 - Math.exp(-dt * rate)
    const calm = REDUCED_MOTION ? 0.3 : 1
    this.kick = Math.max(0, this.kick - dt * 6)
    actor.longKick = this.kick
    actor.update(dt)
    if (!held && actor.forearmR) {
      actor.forearmR.rotation.z += this.kick * this.kick * 0.45
    }
    // his head folds away: the lens is where his eyes were
    actor.head?.scale.setScalar(0.001)
    const swayK = (1 - ads * 0.8) * calm
    this.swayX += (MathUtils.clamp(-lookYaw * 1.4, -0.05, 0.05) * swayK - this.swayX) * e(10)
    this.swayY += (MathUtils.clamp(lookPitch * 1.4, -0.04, 0.04) * swayK - this.swayY) * e(10)
    this.bobAmp += (Math.min(1, speed / 5.5) * (1 - ads * 0.85) - this.bobAmp) * e(8)
    this.bob += dt * (6 + speed * 1.4)
    this.reload += ((reloading ? 1 : 0) - this.reload) * e(9)
    this.push += (MathUtils.clamp(0.8 - wall, 0, 0.35) - this.push) * e(14)
    const bx = Math.cos(this.bob) * 0.01 * this.bobAmp * calm
    const by = Math.abs(Math.sin(this.bob)) * 0.014 * this.bobAmp * calm
    // where the muzzle is without our own offset: aiming brings it to the crosshair
    this.holder.position.set(0, 0, 0)
    this.holder.rotation.set(0, 0, 0)
    this.root.updateMatrixWorld(true)
    this.camera.worldToLocal(muzzleOf(actor, muz))
    this.sight.lerp(muz, e(20))
    const k = this.kick * this.kick
    // the muzzle goes to HIP at the hip and onto the crosshair on the sights
    // the revolver's muzzle rests at HIP and comes onto the crosshair on the sights; a long gun
    // stays shouldered as he holds it (stock at his shoulder, under the eye) and the sights come
    // in toward the line of sight
    const tx = held ? this.sight.x - LONG_ADS.x * ads : MathUtils.lerp(HIP.x, 0, ads)
    const ty = held ? this.sight.y + LONG_ADS.y * ads : MathUtils.lerp(HIP.y, -SIGHT, ads)
    const depth = MathUtils.lerp(HIP_Z, ADS_Z, ads)
    this.holder.position.set(
      tx - this.sight.x + this.swayX + bx,
      ty - this.sight.y + this.swayY - by - this.reload * 0.14 - this.push * 0.15,
      depth + k * (held ? 0.05 : 0.03) + this.push,
    )
    this.holder.rotation.set(
      k * (held ? 0.06 : 0.1) - this.reload * 0.6 + this.swayY * 1.5,
      this.swayX * 1.5,
      this.reload * 0.35 - this.swayX * 1.2,
    )
  }

  dispose(): void {
    this.actor?.dispose()
    this.root.removeFromParent()
  }
}

/** The gun in his hands: a long gun's own muzzle, else the revolver's. */
function muzzleOf(actor: Actor, out: Vector3): Vector3 {
  const long = actor.longHeld
  if (long?.obj.visible) {
    return out.copy(long.a.muzzle).applyMatrix4(long.obj.matrixWorld)
  }
  return actor.muzzle(out)
}
