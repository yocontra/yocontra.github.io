/**
 * Crows on a hitching rail by the duel. They shuffle, peck and turn their heads; at the crow
 * fake-out the whole flock bursts off the rail, flapping hard, climbs over the roofs and is gone,
 * so the fake-out is something you see as well as hear. They're back on the rail by the next
 * duel. One instanced draw on the rigid-part rig.
 */
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  Float32BufferAttribute,
  type Group,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { type Hinge, PartBuilder, placed, RigHerd, rigMaterial } from './critter-rig.ts'
import { STREET } from './street.ts'

const BODY = 0x16_14_18
const HEAD: Hinge = { part: 0, pivot: [0, 0.1, 0.06], axis: [1, 0, 0] }
const WING_L: Hinge = { part: 1, pivot: [0.04, 0.12, 0], axis: [0, 0, 1] }
const WING_R: Hinge = { part: 2, pivot: [-0.04, 0.12, 0], axis: [0, 0, 1] }
/** The fold: each wing swung back along the back while perched. */
const FOLD_L: Hinge = { part: 3, pivot: [0.04, 0.12, 0], axis: [0, 1, 0] }
const FOLD_R: Hinge = { part: 4, pivot: [-0.04, 0.12, 0], axis: [0, 1, 0] }

/** anim: x phase, y flapping (0 folded .. 1 full beat), z head bob (0..1). */
const CROW_GLSL = /* glsl */ `
float partAngle(float part, float t, vec4 anim) {
  if (part < 0.5) {
    return anim.z * 0.7 * max(0.0, sin(t * 7.0 + anim.x)) + 0.1 * sin(t * 1.7 + anim.x);
  }
  if (part < 2.5) {
    float side = part < 1.5 ? 1.0 : -1.0;
    // beating: up and down past level; folded, the tips droop a little
    float beat = sin(t * 15.0 + anim.x) * 0.95 + 0.15;
    return side * mix(-0.12, beat, anim.y);
  }
  // perched, the wings lie swept back along the back to the tail
  float fold = part < 3.5 ? 1.0 : -1.0;
  return fold * (1.0 - anim.y) * 1.62;
}
`

/** A flat wing: a long tapered quad, out along ±x from the shoulder. */
function wing(side: number): BufferGeometry {
  const g = new BufferGeometry()
  const s = side
  const p = [
    [s * 0.04, 0.12, 0.05],
    [s * 0.04, 0.12, -0.07],
    [s * 0.3, 0.13, -0.1],
    [s * 0.27, 0.13, 0.01],
  ]
  const tri = (a: number, b: number, c: number) => [p[a], p[b], p[c]].flat()
  const pos = [
    ...tri(0, 1, 2),
    ...tri(0, 2, 3),
    ...tri(0, 2, 1),
    ...tri(0, 3, 2),
  ].flat() as number[]
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

function crowGeometry(): BufferGeometry {
  const b = new PartBuilder()
  b.add(placed(new SphereGeometry(0.06, 8, 6), [0, 0.1, -0.01], [0, 0, 0], [0.85, 0.85, 1.6]), BODY)
  b.add(placed(new BoxGeometry(0.07, 0.015, 0.12), [0, 0.11, -0.15], [0.15, 0, 0]), BODY)
  b.add(placed(new SphereGeometry(0.038, 8, 6), [0, 0.15, 0.09]), BODY, HEAD)
  b.add(
    placed(new ConeGeometry(0.012, 0.055, 5), [0, 0.145, 0.14], [Math.PI / 2, 0, 0]),
    0x2a_26_22,
    HEAD,
  )
  b.add(wing(1), BODY, WING_L, FOLD_L)
  b.add(wing(-1), BODY, WING_R, FOLD_R)
  for (const s of [-1, 1]) {
    b.add(placed(new BoxGeometry(0.006, 0.05, 0.006), [s * 0.018, 0.025, 0.0]), 0x2a_26_22)
  }
  return b.build()
}

interface Crow {
  perch: Vector3
  yaw: number
  /** Seconds since takeoff (-1: perched). */
  fly: number
  delay: number
  dir: Vector3
  bob: number
  shuffle: number
  pos: Vector3
}

/** The post office's rail, up the left side: in the standoff's frame beyond the outlaw. */
const RAIL_X = -(STREET.half - 0.6)
const RAIL_Y = 1.0
const RAIL_Z = 28

export class Crows {
  readonly herd: RigHerd
  private readonly crows: Crow[] = []
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private t = 0
  /** Where the flock sat (for the caw and for the townsfolk to look at). */
  readonly where = new Vector3(RAIL_X, RAIL_Y + 0.4, RAIL_Z)

  constructor(root: Group, count: number) {
    this.herd = new RigHerd(
      crowGeometry(),
      rigMaterial('crow', CROW_GLSL, [60, 60, 20], 0.55),
      count,
    )
    this.herd.mesh.name = 'crows'
    for (let i = 0; i < count; i++) {
      const z = RAIL_Z - 1.0 + (i / Math.max(1, count - 1)) * 2.0 + (Math.random() - 0.5) * 0.12
      const perch = new Vector3(RAIL_X, RAIL_Y, z)
      this.crows.push({
        perch,
        yaw: Math.PI / 2 + (Math.random() - 0.5) * 1.8,
        fly: -1,
        delay: 0,
        dir: new Vector3(),
        bob: 0,
        shuffle: Math.random() * 5,
        pos: perch.clone(),
      })
      this.herd.setCoat(i, BODY)
    }
    root.add(this.herd.mesh)
  }

  /** Burst off the rail: each a beat after the last, up and away over the roofs. */
  takeOff(): void {
    this.crows.forEach((c, i) => {
      if (c.fly >= 0) {
        return
      }
      c.fly = 0
      c.delay = i * 0.06 + Math.random() * 0.08
      // across the street, high over it beyond the outlaw, and away over the far roofs: in
      // frame on every screen, however narrow
      c.dir.set(0.85 + Math.random() * 0.2, 0, -0.1 + Math.random() * 0.45).normalize()
    })
  }

  get flying(): boolean {
    return this.crows.some((c) => c.fly >= 0)
  }

  /** Back on the rail (between duels). */
  reset(): void {
    for (const c of this.crows) {
      c.fly = -1
      c.pos.copy(c.perch)
    }
  }

  update(dt: number): void {
    this.t += dt
    this.crows.forEach((c, i) => {
      let flap = 0
      let pitch = 0
      if (c.fly < 0) {
        // perched: shuffle round now and then, peck at the rail
        c.shuffle -= dt
        if (c.shuffle <= 0) {
          c.shuffle = 2 + Math.random() * 5
          c.yaw += (Math.random() - 0.5) * 1.6
        }
        c.bob = Math.max(0, Math.sin(this.t * 0.6 + i * 1.9)) ** 4
        c.pos.copy(c.perch)
      } else {
        c.fly += dt
        const u = c.fly - c.delay
        if (u > 0) {
          // a hop up, then a hard climbing flight that flattens out
          const climb = Math.min(u, 0.5) * 5 + Math.max(0, u - 0.5) * 2.2
          const along = u * u * 1.6 + u * 3.2
          c.pos.set(c.perch.x + c.dir.x * along, c.perch.y + climb, c.perch.z + c.dir.z * along)
          c.yaw = Math.atan2(c.dir.x, c.dir.z)
          flap = 1
          pitch = -0.45 * Math.max(0, 1 - u)
        }
        if (u > 6) {
          c.pos.set(0, -50, 0)
        }
      }
      this.herd.setAnim(i, flap, c.bob, 0)
      this.q.setFromAxisAngle(new Vector3(0, 1, 0), c.yaw)
      this.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch))
      this.m.compose(c.pos, this.q, new Vector3(1.35, 1.35, 1.35))
      this.herd.setMatrix(i, this.m)
    })
  }
}
