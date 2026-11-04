// biome-ignore-all lint/complexity/useMaxParams: a throw is two points and a fuse, positionally
/**
 * Map pickups and dynamite: a weapon floating and turning over a glowing ring at each layout
 * pickup spot while it's available (shotgun, rifle, dynamite), lobbed sticks of dynamite flying
 * their arc then fizzing on the ground until the fuse runs out. The server owns every rule; this
 * only shows the state the events describe.
 */
import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, type Object3D, Vector3 } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { propDef, propObject } from '../../scene/props.ts'
import { rifleObject } from '../../scene/rifle.ts'
import type { PickupSpot } from '../sim/layout.ts'
import { shotgunMesh } from './shotgun.ts'

const ARC_S = 0.55
/** A thrown bundle: its scale, and the fuse tip's height in the bundle's own frame (0.4 tall). */
const THROWN_SCALE = 1.5
const FUSE_Y = 0.4
/**
 * Landed, it lies over on its side (rolled LIE_ROLL about Z round its foot); lifted so its lowest
 * stick rests on the dirt (at 0.05 it lay a third buried): the bundle's half-width x sin(roll).
 */
const LIE_ROLL = 1.4
const LIE_Y = 0.1 * THROWN_SCALE * Math.sin(LIE_ROLL)

function dynamiteBundle(): Group {
  const g = new Group()
  const mat = new MeshStandardMaterial({ color: 0xc0_2a_1a, roughness: 0.6, emissive: 0x40_08_00 })
  const stick = new CylinderGeometry(0.045, 0.045, 0.32, 8)
  for (const [x, z] of [
    [-0.05, 0],
    [0.05, 0],
    [0, 0.08],
  ] as const) {
    const m = new Mesh(stick, mat)
    m.position.set(x, 0.16, z)
    g.add(m)
  }
  const fuse = new Mesh(
    new CylinderGeometry(0.008, 0.008, 0.12, 4),
    new MeshStandardMaterial({ color: 0x2a_20_18 }),
  )
  fuse.position.set(0, 0.36, 0.03)
  g.add(fuse)
  return g
}

/** Map guns read a touch bigger than life on their rings (uniformly: no fattening). */
const PICKUP_SCALE = 1.3

/**
 * A long gun turning about its middle, rolled a little toward the sky so the camera sees the
 * receiver's side and the top of the barrels. `mid` is the middle of its length, gun frame.
 */
function longPickup(gun: Object3D, mid: number): Group {
  gun.position.set(-mid, 0, 0)
  const roll = new Group()
  roll.rotation.x = 0.5
  roll.add(gun)
  const g = new Group()
  g.add(roll)
  g.scale.setScalar(PICKUP_SCALE)
  return g
}

interface Thrown {
  obj: Object3D
  from: Vector3
  to: Vector3
  born: number
  fuseEnd: number
}

export class Pickups {
  private readonly root: Object3D
  private readonly items: { spot: PickupSpot; obj: Object3D }[] = []
  private readonly available: boolean[]
  private readonly thrown: Thrown[] = []
  private readonly template: Group

  constructor(root: Object3D, spots: readonly PickupSpot[], props: GLTF) {
    this.root = root
    // the textured bundle from the props kit (tools/build-props.ts), else the plain one
    const tnt = propDef(props, 'dynamite', 0.4, 'y')
    this.template = tnt ? propObject(tnt) : dynamiteBundle()
    this.available = spots.map(() => true)
    for (const spot of spots) {
      let obj: Object3D
      if (spot.kind === 'dynamite') {
        obj = this.template.clone()
        obj.scale.setScalar(1.6)
      } else if (spot.kind === 'shotgun') {
        // the coach gun runs x −0.39..0.59 from its wrist
        obj = longPickup(shotgunMesh(), 0.1)
      } else {
        // the carbine runs x −0.31..0.67 from its receiver
        obj = longPickup(rifleObject(), 0.18)
      }
      obj.position.set(spot.x, 0.9, spot.z)
      // floats over its ring by design (the float audit allows it by this name)
      obj.name = 'pickup'
      root.add(obj)
      this.items.push({ spot, obj })
    }
  }

  /** Spot index → available? (the minimap and the ground rings read this). */
  isAvailable(i: number): boolean {
    return this.available[i] === true
  }

  setAvailable(i: number, on: boolean): void {
    this.available[i] = on
    const it = this.items[i]
    if (it) {
      it.obj.visible = on
    }
  }

  get spots(): readonly { spot: PickupSpot; obj: Object3D }[] {
    return this.items
  }

  /** A stick lobbed from (fx, fz) to land at (x, z), exploding `fuseS` seconds from now. */
  throw(fx: number, fz: number, x: number, z: number, fuseS: number, nowS: number): void {
    const obj = this.template.clone()
    obj.scale.setScalar(THROWN_SCALE)
    this.root.add(obj)
    this.thrown.push({
      obj,
      from: new Vector3(fx, 1.2, fz),
      to: new Vector3(x, LIE_Y, z),
      born: nowS,
      fuseEnd: nowS + fuseS,
    })
  }

  /** Remove the stick nearest (x, z) (it just went off). */
  explode(x: number, z: number): void {
    let best = -1
    let bestD = 4
    for (const [i, t] of this.thrown.entries()) {
      const d = Math.hypot(t.to.x - x, t.to.z - z)
      if (d < bestD) {
        best = i
        bestD = d
      }
    }
    const t = this.thrown[best]
    if (t) {
      t.obj.removeFromParent()
      this.thrown.splice(best, 1)
    }
  }

  /** Spark positions of every lit fuse this frame (the effects layer draws them). */
  update(nowS: number, spark: (x: number, y: number, z: number) => void): void {
    for (const [i, it] of this.items.entries()) {
      if (this.available[i]) {
        it.obj.rotation.y = nowS * 1.6 + i
        it.obj.position.y = 0.85 + Math.sin(nowS * 2.4 + i) * 0.12
      }
    }
    for (const t of [...this.thrown]) {
      const k = Math.min(1, (nowS - t.born) / ARC_S)
      t.obj.position.lerpVectors(t.from, t.to, k)
      t.obj.position.y += Math.sin(k * Math.PI) * 2.4
      t.obj.rotation.z = k < 1 ? k * 12 : LIE_ROLL
      // the spark rides the fuse tip, wherever the tumbling bundle points it
      const rz = t.obj.rotation.z
      const fuse = FUSE_Y * THROWN_SCALE
      spark(
        t.obj.position.x - Math.sin(rz) * fuse,
        t.obj.position.y + Math.cos(rz) * fuse,
        t.obj.position.z,
      )
      if (nowS > t.fuseEnd + 0.4) {
        t.obj.removeFromParent()
        this.thrown.splice(this.thrown.indexOf(t), 1)
      }
    }
  }
}
