// biome-ignore-all lint/style/noExcessiveClassesPerFile: the hens and the town's animals together
/**
 * The town's animals: the horses at the rails and the dog on the porch (`beasts.ts`, animated
 * models), and a few chickens pecking at the street's edge who scatter at a gunshot (one
 * instanced draw on the rigid-part rig, `critter-rig.ts`; the model faces +Z, feet on y = 0).
 */
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  type Group,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { Dog, Horses } from './beasts.ts'
import { type Hinge, PartBuilder, placed, RigHerd, rigMaterial } from './critter-rig.ts'

const X = [1, 0, 0] as const

// ----------------------------------------------------------------------------------- chickens

const HEN_HEAD: Hinge = { part: 1, pivot: [0, 0.3, 0.07], axis: X }

/** anim: x phase, y peck (0..1). */
const HEN_GLSL = /* glsl */ `
float partAngle(float part, float t, vec4 anim) {
  return anim.y * 1.15 + 0.08 * sin(t * 3.0 + anim.x);
}
`

function henGeometry(): ReturnType<PartBuilder['build']> {
  const b = new PartBuilder()
  b.add(
    placed(new SphereGeometry(0.11, 10, 8), [0, 0.22, -0.01], [0, 0, 0], [0.82, 0.9, 1.15]),
    0xff_ff_ff,
    undefined,
    undefined,
    true,
  )
  b.add(
    placed(new ConeGeometry(0.06, 0.12, 6), [0, 0.3, -0.13], [-0.9, 0, 0]),
    0xff_ff_ff,
    undefined,
    undefined,
    true,
  )
  b.add(
    placed(new SphereGeometry(0.055, 8, 6), [0, 0.37, 0.1]),
    0xff_ff_ff,
    HEN_HEAD,
    undefined,
    true,
  )
  b.add(placed(new BoxGeometry(0.015, 0.04, 0.05), [0, 0.43, 0.1]), 0xb0_1e_14, HEN_HEAD)
  b.add(
    placed(new ConeGeometry(0.015, 0.05, 5), [0, 0.365, 0.16], [Math.PI / 2, 0, 0]),
    0xd8_a0_30,
    HEN_HEAD,
  )
  for (const s of [-1, 1]) {
    b.add(placed(new CylinderGeometry(0.008, 0.008, 0.13, 4), [s * 0.035, 0.065, 0]), 0xd8_a0_30)
  }
  return b.build()
}

interface Hen {
  at: Vector3
  yaw: number
  peck: number
  pause: number
  scatter: number
}

class Hens {
  readonly herd: RigHerd
  private readonly hens: Hen[] = []
  private readonly home: Vector3[] = []
  private readonly m = new Matrix4()
  private t = 0

  constructor(root: Group, count: number) {
    this.herd = new RigHerd(henGeometry(), rigMaterial('hen', HEN_GLSL, [30, 30, 30]), count)
    this.herd.mesh.name = 'hens'
    const coats = [0xe8_e0_d0, 0x9a_5a_2e, 0x5a_3a_22]
    for (let i = 0; i < count; i++) {
      const at = new Vector3(-7.9 + Math.random() * 0.8, 0, 23.4 + i * 0.7 + Math.random() * 0.4)
      this.home.push(at.clone())
      this.hens.push({ at, yaw: Math.random() * 6, peck: 0, pause: Math.random() * 2, scatter: 0 })
      this.herd.setCoat(i, coats[i % coats.length] ?? 0xe8_e0_d0)
    }
    root.add(this.herd.mesh)
  }

  /** A gunshot: every hen bolts away from the street. */
  scatter(): void {
    for (const h of this.hens) {
      h.scatter = 1.1 + Math.random() * 0.4
      h.yaw = Math.atan2(-1, (Math.random() - 0.5) * 2)
    }
  }

  reset(): void {
    this.hens.forEach((h, i) => {
      h.at.copy(this.home[i] ?? h.at)
      h.scatter = 0
    })
  }

  update(dt: number): void {
    this.t += dt
    this.hens.forEach((h, i) => {
      let hop = 0
      if (h.scatter > 0) {
        h.scatter -= dt
        h.at.x += Math.sin(h.yaw) * 2.6 * dt
        h.at.z += Math.cos(h.yaw) * 2.6 * dt
        hop = Math.abs(Math.sin(this.t * 18 + i)) * 0.08
        h.peck = 0
      } else {
        h.pause -= dt
        if (h.pause <= 0) {
          h.pause = 0.6 + Math.random() * 2.2
          h.yaw += (Math.random() - 0.5) * 2
        }
        // peck in short runs; amble a step between
        const pecking = Math.sin(this.t * 1.3 + i * 2) > 0
        h.peck = pecking ? Math.max(0, Math.sin(this.t * 11 + i)) : 0
        if (!pecking) {
          const home = this.home[i] ?? h.at
          h.at.x += (Math.sin(h.yaw) * 0.25 + (home.x - h.at.x) * 0.3) * dt
          h.at.z += (Math.cos(h.yaw) * 0.25 + (home.z - h.at.z) * 0.3) * dt
        }
      }
      this.herd.setAnim(i, h.peck, 0, 0)
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), h.yaw)
      this.m.compose(h.at.clone().setY(hop), q, new Vector3(1, 1, 1))
      this.herd.setMatrix(i, this.m)
    })
  }
}

/** Horses, the dog and the chickens. */
export class Animals {
  readonly horses: Horses
  readonly dog: Dog
  readonly hens: Hens | null

  constructor(root: Group, hens: number) {
    this.horses = new Horses(root)
    this.dog = new Dog(root)
    this.hens = hens > 0 ? new Hens(root, hens) : null
  }

  /** `every`: the horses and the dog animate every n-th frame (2 = 30 Hz). */
  update(dt: number, every = 2): void {
    this.horses.update(dt, every)
    this.dog.update(dt, every)
    this.hens?.update(dt)
  }
}
