/**
 * Simple client-side ragdoll for Frontier's kills: a small Verlet body of hips, chest, head and
 * limbs, spawned at the victim's last render position. It is cosmetic only; the server capsule
 * stays authoritative and the crowd actor is hidden while its ragdoll is live.
 *
 * Three pooled bodies. If no slot is free (or the tier is the floor tier), `spawn` returns false
 * and the caller leaves the authored Death clip playing.
 */
import {
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  Vector3,
} from 'three'
import type { PlayerLook } from './looks.ts'

const SLOTS = 3
const GRAVITY = 9.8
const DAMPING = 0.985
const ITERATIONS = 4
const GROUND_Y = 0.04
const SETTLE_AGE = 7
const FADE_TIME = 1.2
/** A slot younger than this cannot be recycled; the death clip is the fallback instead. */
const MIN_LIFE = 1.5
const DEFAULT_SKIN = 0xc8_a0_7a
const DEFAULT_TOP = 0x6a_5a_44
const DEFAULT_BOTTOM = 0x3a_34_2c
const DEFAULT_HAT = 0x4a_3a_2a

/** Points: hips, chest, head, then arms and legs. */
const HIPS = 0
const CHEST = 1
const HEAD = 2
const SHOULDER_L = 3
const ELBOW_L = 4
const HAND_L = 5
const SHOULDER_R = 6
const ELBOW_R = 7
const HAND_R = 8
const HIP_L = 9
const KNEE_L = 10
const FOOT_L = 11
const HIP_R = 12
const KNEE_R = 13
const FOOT_R = 14

/** Rest pose, metres, before the spawn yaw. */
const POSE: readonly (readonly [number, number, number])[] = [
  [0, 0.95, 0],
  [0, 1.34, 0.02],
  [0, 1.6, 0.04],
  [-0.21, 1.44, 0],
  [-0.33, 1.17, 0.04],
  [-0.38, 0.92, 0.07],
  [0.21, 1.44, 0],
  [0.33, 1.17, 0.04],
  [0.38, 0.92, 0.07],
  [-0.12, 0.92, 0],
  [-0.16, 0.52, 0.02],
  [-0.18, 0.08, 0.04],
  [0.12, 0.92, 0],
  [0.16, 0.52, 0.02],
  [0.18, 0.08, 0.04],
]

/** Resting radius per point, so the torso and head lie on the ground with volume. */
const RADII: readonly number[] = [
  0.1, 0.13, 0.12, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.07, 0.06, 0.05, 0.07, 0.06, 0.05,
]

/** Segment meshes: [point a, point b, radius]. */
const SEGMENTS: readonly (readonly [number, number, number])[] = [
  [HIPS, CHEST, 0.13],
  [CHEST, HEAD, 0.07],
  [SHOULDER_L, ELBOW_L, 0.055],
  [ELBOW_L, HAND_L, 0.05],
  [SHOULDER_R, ELBOW_R, 0.055],
  [ELBOW_R, HAND_R, 0.05],
  [HIP_L, KNEE_L, 0.07],
  [KNEE_L, FOOT_L, 0.06],
  [HIP_R, KNEE_R, 0.07],
  [KNEE_R, FOOT_R, 0.06],
]

/** Distance constraints: [a, b]. */
const STICKS: readonly (readonly [number, number])[] = [
  [HIPS, CHEST],
  [CHEST, HEAD],
  [CHEST, SHOULDER_L],
  [CHEST, SHOULDER_R],
  [SHOULDER_L, SHOULDER_R],
  [SHOULDER_L, ELBOW_L],
  [ELBOW_L, HAND_L],
  [SHOULDER_R, ELBOW_R],
  [ELBOW_R, HAND_R],
  [HIPS, HIP_L],
  [HIP_L, KNEE_L],
  [KNEE_L, FOOT_L],
  [HIPS, HIP_R],
  [HIP_R, KNEE_R],
  [KNEE_R, FOOT_R],
  [CHEST, HIP_L],
  [CHEST, HIP_R],
]

interface Point {
  x: number
  y: number
  z: number
  px: number
  py: number
  pz: number
}

interface Slot {
  group: Group
  points: Point[]
  rest: number[]
  active: boolean
  id: number
  age: number
  parts: Mesh[]
  top: MeshStandardMaterial
  bottom: MeshStandardMaterial
  skin: MeshStandardMaterial
  hat: MeshStandardMaterial
  hatMesh: Mesh
  baseY: number
  groundAt: (x: number, z: number, feetY: number) => number
}

const UP = new Vector3(0, 1, 0)
const dir = new Vector3()
const mid = new Vector3()
const color = new Color()

/** Integrate one Verlet step, with the floor under the body. */
function integrate(slot: Slot, dt: number): void {
  for (const [i, p] of slot.points.entries()) {
    const vx = (p.x - p.px) * DAMPING
    const vy = (p.y - p.py) * DAMPING
    const vz = (p.z - p.pz) * DAMPING
    p.px = p.x
    p.py = p.y
    p.pz = p.z
    p.x += vx
    p.y += vy - GRAVITY * dt * dt
    p.z += vz
    const floor =
      slot.groundAt(p.x + slot.group.position.x, p.z + slot.group.position.z, slot.baseY + 0.2) +
      GROUND_Y +
      (RADII[i] ?? 0.05) -
      slot.group.position.y
    if (p.y < floor) {
      p.y = floor
      // Ground friction: kill most of the horizontal slide, keep a little tumble.
      p.px = p.x - (p.x - p.px) * 0.35
      p.pz = p.z - (p.z - p.pz) * 0.35
      p.py = p.y
    }
  }
}

/** Pull every bone toward its rest length. */
function constrain(slot: Slot): void {
  for (const [k, [a, b]] of STICKS.entries()) {
    const pa = slot.points[a]
    const pb = slot.points[b]
    if (!(pa && pb)) {
      continue
    }
    let dx = pb.x - pa.x
    let dy = pb.y - pa.y
    let dz = pb.z - pa.z
    const d = Math.hypot(dx, dy, dz) || 1e-4
    const diff = ((d - (slot.rest[k] ?? 0.1)) / d) * 0.5
    dx *= diff
    dy *= diff
    dz *= diff
    pa.x += dx
    pa.y += dy
    pa.z += dz
    pb.x -= dx
    pb.y -= dy
    pb.z -= dz
  }
}

/** Place each limb between its two points and sit the hat on the head. */
function render(slot: Slot): void {
  for (const [k, [a, b, radius]] of SEGMENTS.entries()) {
    const pa = slot.points[a]
    const pb = slot.points[b]
    const mesh = slot.parts[k]
    if (!(pa && pb && mesh)) {
      continue
    }
    dir.set(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z)
    const len = dir.length() || 0.01
    mid.set((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2)
    mesh.position.copy(mid)
    mesh.quaternion.setFromUnitVectors(UP, dir.normalize())
    mesh.scale.set(radius, len, radius)
  }
  const chest = slot.points[CHEST]
  const head = slot.points[HEAD]
  if (chest && head) {
    dir.set(head.x - chest.x, head.y - chest.y, head.z - chest.z).normalize()
    slot.hatMesh.position.set(head.x + dir.x * 0.09, head.y + dir.y * 0.09, head.z + dir.z * 0.09)
    slot.hatMesh.quaternion.setFromUnitVectors(UP, dir)
  }
}

export class Ragdolls {
  private readonly slots: Slot[] = []
  private readonly enabled: boolean
  private readonly groundAt: (x: number, z: number, feetY: number) => number
  private readonly cylinder = new CylinderGeometry(1, 1, 1, 6, 1, false)
  private readonly headGeo = new SphereGeometry(1, 8, 6)
  private readonly hatGeo = new CylinderGeometry(0.34, 0.52, 0.12, 10)

  constructor(
    root: Object3D,
    enabled: boolean,
    groundAt: (x: number, z: number, feetY: number) => number,
  ) {
    this.enabled = enabled
    this.groundAt = groundAt
    for (let i = 0; i < SLOTS; i++) {
      const group = new Group()
      group.name = `ragdoll-${i}`
      group.visible = false
      root.add(group)
      const top = new MeshStandardMaterial({ color: DEFAULT_TOP, roughness: 0.9 })
      const bottom = new MeshStandardMaterial({ color: DEFAULT_BOTTOM, roughness: 0.9 })
      const skin = new MeshStandardMaterial({ color: DEFAULT_SKIN, roughness: 0.8 })
      const hat = new MeshStandardMaterial({ color: DEFAULT_HAT, roughness: 0.9 })
      const parts = SEGMENTS.map(([, , radius], k) => {
        const mesh = new Mesh(this.cylinder, k < 6 ? top : bottom)
        mesh.scale.set(radius, 1, radius)
        mesh.castShadow = true
        group.add(mesh)
        return mesh
      })
      const head = new Mesh(this.headGeo, skin)
      head.scale.setScalar(0.11)
      head.castShadow = true
      group.add(head)
      const hatMesh = new Mesh(this.hatGeo, hat)
      hatMesh.scale.setScalar(0.22)
      hatMesh.castShadow = true
      group.add(hatMesh)
      this.slots.push({
        group,
        points: POSE.map(() => ({ x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0 })),
        rest: STICKS.map(() => 0),
        active: false,
        id: -1,
        age: 0,
        parts,
        top,
        bottom,
        skin,
        hat,
        hatMesh,
        baseY: 0,
        groundAt: () => 0,
      })
    }
  }

  /** Spawn at the victim's feet, pushed away from the killer. False means keep the death clip. */
  spawn(
    id: number,
    at: { x: number; y?: number; z: number },
    from: { x: number; z: number } | null,
    look: PlayerLook | null,
  ): boolean {
    if (!this.enabled) {
      return false
    }
    let slot = this.slots.find((s) => !s.active)
    if (!slot) {
      const oldest = this.slots.reduce((a, b) => (a.age >= b.age ? a : b))
      if (oldest.age < MIN_LIFE) {
        return false
      }
      slot = oldest
    }
    slot.active = true
    slot.id = id
    slot.age = 0
    slot.baseY = at.y ?? 0
    slot.groundAt = this.groundAt
    slot.group.visible = true
    slot.group.position.set(at.x, slot.baseY, at.z)
    slot.group.scale.setScalar(1)
    slot.top.color.copy(look ? look.top : color.setHex(DEFAULT_TOP))
    slot.bottom.color.copy(look ? look.bottom : color.setHex(DEFAULT_BOTTOM))
    slot.skin.color.copy(look ? look.skin : color.setHex(DEFAULT_SKIN))
    slot.hat.color.setHex(look?.hatColor ?? DEFAULT_HAT)
    const dx = from ? at.x - from.x : 0
    const dz = from ? at.z - from.z : 0
    const d = Math.hypot(dx, dz) || 1
    const yaw = from ? Math.atan2(dz, dx) + Math.PI / 2 : Math.random() * Math.PI * 2
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    const pushX = (dx / d) * 1.6
    const pushZ = (dz / d) * 1.6
    const dt = 1 / 60
    for (const [i, base] of POSE.entries()) {
      const p = slot.points[i]
      if (!p) {
        continue
      }
      const bx = base[0] * cos - base[2] * sin
      const bz = base[0] * sin + base[2] * cos
      p.x = bx
      p.y = base[1]
      p.z = bz
      // Verlet velocity from the killer's direction, plus a little spin.
      const spin = (i % 3) - 1
      p.px = p.x - (pushX + spin * 0.35) * dt
      p.py = p.y - (0.5 + (i % 4) * 0.15) * dt
      p.pz = p.z - (pushZ - spin * 0.35) * dt
    }
    for (const [k, [a, b]] of STICKS.entries()) {
      const pa = slot.points[a]
      const pb = slot.points[b]
      slot.rest[k] = pa && pb ? Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) : 0.1
    }
    return true
  }

  /** The victim respawned: drop their ragdoll immediately. */
  release(id: number): void {
    for (const slot of this.slots) {
      if (slot.active && slot.id === id) {
        slot.active = false
        slot.group.visible = false
      }
    }
  }

  update(dt: number): void {
    if (!this.enabled) {
      return
    }
    const step = Math.min(dt, 1 / 30)
    for (const slot of this.slots) {
      if (!slot.active) {
        continue
      }
      slot.age += dt
      integrate(slot, step)
      for (let it = 0; it < ITERATIONS; it++) {
        constrain(slot)
      }
      render(slot)
      if (slot.age > SETTLE_AGE) {
        const k = 1 - (slot.age - SETTLE_AGE) / FADE_TIME
        if (k <= 0) {
          slot.active = false
          slot.group.visible = false
        } else {
          slot.group.scale.setScalar(k)
        }
      }
    }
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.group.removeFromParent()
      slot.top.dispose()
      slot.bottom.dispose()
      slot.skin.dispose()
      slot.hat.dispose()
    }
    this.cylinder.dispose()
    this.headGeo.dispose()
    this.hatGeo.dispose()
  }
}
