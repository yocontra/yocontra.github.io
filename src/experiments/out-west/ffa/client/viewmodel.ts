// biome-ignore-all lint/complexity/useMaxParams: the per-frame update takes positional numbers
/**
 * The first-person view model: the gun in your hand (revolver, rifle or coach gun, the same props
 * the riders carry), a gloved hand and a sleeve in your shirt colour, parented to the camera. It
 * sways against the look, bobs with your stride, kicks on every shot, dips while you reload,
 * comes up to the sights when you aim, and pulls back off a wall instead of poking through it.
 * Never casts shadows; three to six draws.
 */
import {
  Box3,
  type BufferGeometry,
  type Camera,
  type Color,
  CylinderGeometry,
  Group,
  type Material,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  Vector3,
} from 'three'
import { WEAPON_REVOLVER, WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../contract/town.ts'
import type { Assets } from '../../engine/assets.ts'
import { propDef, propObject } from '../../scene/props.ts'
import { kitMaterial, shotgunMesh } from '../scene/shotgun.ts'

/** Hip and sight positions in camera space (camera looks down −Z). */
const HIP = new Vector3(0.16, -0.16, -0.38)
/** Aiming down the sights: centred, with the sight line a hair under the crosshair. */
const SIGHTS = new Vector3(0, 0, -0.34)
const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

interface Gun {
  root: Group
  /** Muzzle in the gun root's space. */
  muzzle: Vector3
  /** Where the grip hand and the support hand sit, in the gun root's space. */
  grip: Vector3
  fore: Vector3 | null
  /** Height of the sight line above the grip origin (m). */
  top: number
}

const tmp = new Vector3()
const tmp2 = new Vector3()

export class ViewModel {
  readonly root = new Group()
  private readonly guns = new Map<number, Gun>()
  private readonly sleeve: Material
  private readonly gloveR: Group
  private readonly gloveL: Group
  private weapon = -1
  private kick = 0
  private swayX = 0
  private swayY = 0
  private bob = 0
  private bobAmp = 0
  private reload = 0
  private push = 0

  constructor(camera: Camera, assets: Assets) {
    this.root.name = 'viewmodel'
    this.root.visible = false
    camera.add(this.root)
    const kit = kitMaterial(assets.props)
    const revolver = propDef(assets.props, 'revolver', 0.3)
    if (revolver) {
      const g = propObject(revolver)
      g.traverse((o) => {
        if (o instanceof Mesh && !Array.isArray(o.material) && o.material.name === 'Kit') {
          o.material = kit
        }
      })
      this.guns.set(WEAPON_REVOLVER, fitGun(g, false))
    }
    const rifle = propDef(assets.props, 'rifle', 1.0)
    if (rifle) {
      const inner = propObject(rifle)
      // the rifle prop lies along Z, muzzle at +Z; turn it down +X like the others
      inner.rotation.y = Math.PI / 2
      const g = new Group()
      g.add(inner)
      this.guns.set(WEAPON_RIFLE, fitGun(g, true))
    }
    const sg = new Group()
    sg.add(shotgunMesh(kit))
    sg.scale.setScalar(0.95)
    this.guns.set(WEAPON_SHOTGUN, fitGun(sg, true))
    for (const gun of this.guns.values()) {
      gun.root.visible = false
      this.root.add(gun.root)
    }
    this.sleeve = new MeshStandardMaterial({ color: 0x6a_4a_32, roughness: 0.9 })
    const glove = new MeshStandardMaterial({ color: 0x4a_30_1c, roughness: 0.75 })
    this.gloveR = hand(glove, this.sleeve)
    this.gloveL = hand(glove, this.sleeve)
    this.root.add(this.gloveR, this.gloveL)
    this.root.traverse((o) => {
      o.castShadow = false
      o.receiveShadow = false
      o.frustumCulled = false
      // drawn after the world, over anything it might graze
      o.renderOrder = 10
    })
  }

  /** Your shirt colour on the sleeves. */
  setSleeve(c: Color): void {
    ;(this.sleeve as MeshStandardMaterial).color.copy(c)
  }

  get visible(): boolean {
    return this.root.visible
  }

  set visible(v: boolean) {
    this.root.visible = v
  }

  /** A shot: the gun kicks up and back. */
  fired(): void {
    this.kick = 1
  }

  /** The muzzle in world space (for the tracer and the flash). */
  muzzle(out: Vector3): Vector3 {
    const g = this.guns.get(this.weapon)
    if (!g) {
      return out.set(0, 0, -0.5).applyMatrix4(this.root.matrixWorld)
    }
    g.root.updateWorldMatrix(true, false)
    return out.copy(g.muzzle).applyMatrix4(g.root.matrixWorld)
  }

  /**
   * Per frame: `look` is this frame's look movement (rad), `speed` your planar speed, `ads` the
   * sights blend 0..1, `reloading` while the reload runs, `wall` the distance to a wall ahead (m).
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
    if (!this.root.visible) {
      return
    }
    if (weapon !== this.weapon) {
      this.weapon = weapon
      for (const [w, g] of this.guns) {
        g.root.visible = w === weapon
      }
    }
    const g = this.guns.get(weapon)
    const e = (rate: number) => 1 - Math.exp(-dt * rate)
    const calm = REDUCED_MOTION ? 0.3 : 1
    // sway: the gun trails the look a little, less on the sights
    const swayK = (1 - ads * 0.75) * calm
    this.swayX += (MathUtils.clamp(-lookYaw * 1.6, -0.06, 0.06) * swayK - this.swayX) * e(10)
    this.swayY += (MathUtils.clamp(lookPitch * 1.6, -0.05, 0.05) * swayK - this.swayY) * e(10)
    this.bobAmp += (Math.min(1, speed / 5.5) * (1 - ads * 0.8) - this.bobAmp) * e(8)
    this.bob += dt * (6 + speed * 1.4)
    this.kick = Math.max(0, this.kick - dt * 7)
    this.reload += ((reloading ? 1 : 0) - this.reload) * e(9)
    this.push += (MathUtils.clamp(0.75 - wall, 0, 0.35) - this.push) * e(14)
    const k = this.kick * this.kick
    const long = weapon === WEAPON_RIFLE || weapon === WEAPON_SHOTGUN
    const bx = Math.cos(this.bob) * 0.012 * this.bobAmp * calm
    const by = Math.abs(Math.sin(this.bob)) * 0.016 * this.bobAmp * calm
    const sights = tmp2.copy(SIGHTS)
    sights.y = -((g?.top ?? 0.1) + 0.012)
    const pos = tmp.copy(HIP).lerp(sights, ads)
    if (long) {
      pos.y -= 0.02 * (1 - ads)
    }
    this.root.position.set(
      pos.x + this.swayX + bx,
      pos.y + this.swayY - by - this.reload * 0.12 - this.push * 0.2,
      pos.z + k * (long ? 0.09 : 0.06) + this.push,
    )
    this.root.rotation.set(
      k * (long ? 0.18 : 0.42) - this.reload * 0.7 + this.swayY * 2,
      this.swayX * 2 + (1 - ads) * 0.04,
      this.reload * 0.5 - this.swayX * 1.5,
    )
    if (g) {
      place(this.gloveR, g.grip, g.root)
      this.gloveL.visible = g.fore !== null
      if (g.fore) {
        place(this.gloveL, g.fore, g.root)
      }
    }
  }
}

/**
 * Point the gun down −Z and centre it on its grip; measure the muzzle and the sight line. The props
 * don't agree on which way their barrels run, so it's measured: the barrel is the longest level
 * axis, and the grip hangs below its rear half, so the muzzle is the far end from the grip.
 */
function fitGun(g: Group, long: boolean): Gun {
  const root = new Group()
  const turn = new Group()
  turn.add(g)
  root.add(turn)
  root.updateMatrixWorld(true)
  const box0 = new Box3().setFromObject(turn)
  const size0 = box0.getSize(new Vector3())
  const alongX = size0.x >= size0.z
  const low = lowCentroid(turn, box0)
  const mid = alongX ? (box0.min.x + box0.max.x) / 2 : (box0.min.z + box0.max.z) / 2
  const gripSide = (alongX ? low.x : low.z) - mid
  // the muzzle points away from the grip: turn it to −Z
  if (alongX) {
    turn.rotation.y = gripSide < 0 ? Math.PI / 2 : -Math.PI / 2
  } else {
    turn.rotation.y = gripSide < 0 ? Math.PI : 0
  }
  root.updateMatrixWorld(true)
  const box = new Box3().setFromObject(turn)
  const size = box.getSize(new Vector3())
  // the hand closes on the grip: a quarter of the way up, near the back (further forward on a
  // long gun, where the wrist of the stock is)
  const grip = new Vector3(
    (box.min.x + box.max.x) / 2,
    box.min.y + size.y * 0.25,
    box.max.z - size.z * (long ? 0.32 : 0.2),
  )
  turn.position.sub(grip)
  const muzzle = new Vector3((box.min.x + box.max.x) / 2, box.max.y - size.y * 0.3, box.min.z).sub(
    grip,
  )
  const fore = long ? new Vector3(0, -size.y * 0.1, -size.z * 0.36) : null
  return {
    root,
    muzzle,
    grip: new Vector3(0, -size.y * 0.08, 0.01),
    fore,
    top: box.max.y - grip.y,
  }
}

/** Centroid of the vertices in the bottom 40% of a group (where a grip or a stock hangs). */
function lowCentroid(obj: Object3D, box: Box3): Vector3 {
  const cut = box.min.y + (box.max.y - box.min.y) * 0.4
  const sum = new Vector3()
  const v = new Vector3()
  let n = 0
  obj.updateMatrixWorld(true)
  obj.traverse((o) => {
    if (!(o instanceof Mesh)) {
      return
    }
    const pos = (o.geometry as BufferGeometry).getAttribute('position')
    if (!pos) {
      return
    }
    const step = Math.max(1, Math.floor(pos.count / 400))
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)
      if (v.y <= cut) {
        sum.add(v)
        n++
      }
    }
  })
  return n > 0 ? sum.divideScalar(n) : box.getCenter(sum)
}

/** A gloved fist with a sleeve running back toward the camera's corner. */
function hand(glove: Material, sleeve: Material): Group {
  const g = new Group()
  const fist = new Mesh(new SphereGeometry(0.032, 10, 8), glove)
  fist.scale.set(1, 0.9, 1.25)
  const cuff = new Mesh(new CylinderGeometry(0.036, 0.04, 0.05, 10), glove)
  cuff.rotation.x = Math.PI / 2
  cuff.position.z = 0.05
  const arm = new Mesh(new CylinderGeometry(0.036, 0.042, 0.22, 10), sleeve)
  arm.rotation.x = Math.PI / 2
  arm.position.z = 0.15
  g.add(fist, cuff, arm)
  // the forearm runs back, down and out toward the body, never across the view
  g.rotation.set(0.75, 0.4, 0)
  return g
}

function place(glove: Object3D, at: Vector3, gun: Group): void {
  glove.position.copy(at).applyMatrix4(gun.matrix)
}
