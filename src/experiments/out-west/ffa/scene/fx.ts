// biome-ignore-all lint/style/noExcessiveLinesPerFile: every Frontier effect pool lives in one module (one draw each)
// biome-ignore-all lint/style/noExcessiveClassesPerFile: the Frontier effects are small pooled classes, kept together
// biome-ignore-all lint/complexity/useMaxParams: effect spawners take positional numeric args
/**
 * Frontier effects, every one a pooled InstancedMesh (one draw each, no per-shot allocation):
 * tracers, muzzle flashes, impact puffs (dust on walls, red on hits), money bags, the strongbox
 * and its beacon, ground rings (your marker, bank windows, the Call Out ring, the showdown dust
 * ring), the aim line, and thrown hats. Bright colours go above 1 so the bloom picks them up.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  type Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three'
import { sackLook, strongboxLook } from '../../scene/surface.ts'
import { softDot } from '../../scene/textures.ts'
import { type Bag, PLAIN_BAG } from './bags.ts'

const m4 = new Matrix4()
const q = new Quaternion()
const v = new Vector3()
const s = new Vector3()
const up = new Vector3(0, 1, 0)
const forward = new Vector3(0, 0, 1)
const tc = new Color()
const flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)

interface Slot {
  t: number
  life: number
  x: number
  y: number
  z: number
  dx: number
  dz: number
  len: number
  size: number
  vx: number
  vy: number
  vz: number
  /** Surface normal for decal quads. */
  nx: number
  ny: number
  nz: number
  color: Color
}

function pool(n: number): Slot[] {
  return Array.from({ length: n }, () => ({
    t: 1,
    life: 0,
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dz: 0,
    len: 0,
    size: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    nx: 0,
    ny: 0,
    nz: 1,
    color: new Color(),
  }))
}

/** A pool of short-lived instanced quads. */
class Burst {
  readonly mesh: InstancedMesh
  private readonly slots: Slot[]
  private next = 0
  private readonly draw: (sl: Slot, k: number, out: Matrix4) => void

  constructor(mesh: InstancedMesh, n: number, draw: (sl: Slot, k: number, out: Matrix4) => void) {
    this.mesh = mesh
    this.slots = pool(n)
    this.draw = draw
    mesh.frustumCulled = false
    mesh.count = 0
    mesh.renderOrder = 5
  }

  spawn(): Slot {
    const sl = this.slots[this.next] ?? (this.slots[0] as Slot)
    this.next = (this.next + 1) % this.slots.length
    sl.t = 0
    return sl
  }

  update(dt: number): void {
    let n = 0
    for (const sl of this.slots) {
      if (sl.t >= sl.life) {
        continue
      }
      sl.t += dt
      const k = Math.min(1, sl.t / sl.life)
      sl.x += sl.vx * dt
      sl.y += sl.vy * dt
      sl.z += sl.vz * dt
      this.draw(sl, k, m4)
      this.mesh.setMatrixAt(n, m4)
      this.mesh.setColorAt(n, tc.copy(sl.color).multiplyScalar(1 - k))
      n++
    }
    this.mesh.count = n
    this.mesh.visible = n > 0
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true
    }
  }
}

const additive = (map: MeshBasicMaterial['map'] = null) =>
  new MeshBasicMaterial({
    map,
    color: 0xff_ff_ff,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    // additive and no depth write: back-then-front passes change nothing but cost a program
    // re-resolve each (three.js flips `side` and bumps the material version per draw)
    forceSinglePass: true,
    toneMapped: false,
  })

function seedColors(mesh: InstancedMesh): void {
  const c = new Color(1, 1, 1)
  mesh.setColorAt(0, c)
}

/** A soft soot hole with a ragged bright lip, for wall impacts. */
function holeTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30)
    g.addColorStop(0, 'rgba(12,10,8,0.95)')
    g.addColorStop(0.35, 'rgba(26,20,14,0.8)')
    g.addColorStop(0.62, 'rgba(70,56,40,0.35)')
    g.addColorStop(1, 'rgba(70,56,40,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(32, 32, 30, 0, Math.PI * 2)
    ctx.fill()
    // a few spokes so the round stays a chip, not a dot
    ctx.strokeStyle = 'rgba(18,14,10,0.55)'
    ctx.lineWidth = 2
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4
      ctx.beginPath()
      ctx.moveTo(32, 32)
      ctx.lineTo(32 + Math.cos(a) * 22, 32 + Math.sin(a) * 22)
      ctx.stroke()
    }
  }
  const t = new CanvasTexture(c)
  return t
}

const bagTint = new Color() // each bag's instance colour: the dropper's saddlebag

export type { Bag } from './bags.ts'

export class Effects {
  readonly root: Object3D
  private readonly tracers: Burst
  private readonly flashes: Burst
  private readonly puffs: Burst
  private readonly holes: Burst
  private readonly casingMesh: InstancedMesh
  private readonly dustMesh: InstancedMesh
  /** Where the ambient dust field follows (the player), set by the game each frame. */
  readonly dustFocus = new Vector3()
  private readonly dustSeeds = Array.from({ length: 32 }, (_, i) => ({
    ox: (((i * 37) % 100) / 100 - 0.5) * 12,
    oy: 0.35 + (((i * 53) % 100) / 100) * 2.8,
    oz: (((i * 71) % 100) / 100 - 0.5) * 12,
    phase: (i * 2.399) % (Math.PI * 2),
  }))
  private dustTime = 0
  private readonly casings = Array.from({ length: 24 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    spin: 0,
    t: 1,
    life: 0,
  }))
  private casingNext = 0
  private readonly bagMesh: InstancedMesh
  readonly bags = new Map<number, Bag>()
  /** Muzzle-flash size (1 top-down; the shooter views shrink it). */
  flashScale = 1
  /** First person: your eye, so no puff bursts inside it; else null. */
  eye: { x: number; z: number } | null = null
  private readonly box: Mesh
  private readonly beacon: Mesh
  private readonly rings: InstancedMesh
  /** This frame's rings: a fixed pool, `ringCount` of them live (nothing allocated per frame). */
  private readonly ringList: { x: number; z: number; r: number; color: Color; pulse: number }[] =
    Array.from({ length: 24 }, () => ({ x: 0, z: 0, r: 0, color: new Color(), pulse: 0 }))
  private ringCount = 0
  readonly aimLine: Mesh
  private readonly hats: {
    g: Group
    vx: number
    vy: number
    vz: number
    spin: number
    t: number
  }[] = []
  private time = 0

  constructor(root: Object3D) {
    this.root = root
    const dot = softDot()
    // Tracers: a unit quad lying flat, stretched along the shot.
    const tracerGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5)
    this.tracers = new Burst(new InstancedMesh(tracerGeo, additive(dot), 48), 48, (sl, k, out) => {
      const yaw = Math.atan2(-sl.dx, -sl.dz)
      q.setFromAxisAngle(up, yaw)
      const len = sl.len * Math.min(1, k * 3 + 0.35)
      s.set(0.09 * (1 - k * 0.5), 1, len)
      out.compose(v.set(sl.x, sl.y, sl.z), q, s)
    })
    this.flashes = new Burst(
      new InstancedMesh(new PlaneGeometry(1, 1), additive(dot), 24),
      24,
      (sl, k, out) => {
        s.setScalar(sl.size * (1 - k * 0.6))
        out.compose(v.set(sl.x, sl.y, sl.z), flat, s)
      },
    )
    this.puffs = new Burst(
      new InstancedMesh(new PlaneGeometry(1, 1), additive(dot), 160),
      160,
      (sl, k, out) => {
        s.setScalar(sl.size * (0.6 + k))
        out.compose(v.set(sl.x, sl.y, sl.z), flat, s)
      },
    )
    const holeMat = new MeshBasicMaterial({
      map: holeTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: DoubleSide,
      toneMapped: false,
    })
    this.holes = new Burst(
      new InstancedMesh(new PlaneGeometry(1, 1), holeMat, 48),
      48,
      (sl, k, out) => {
        q.setFromUnitVectors(forward, v.set(sl.nx, sl.ny, sl.nz))
        s.setScalar(sl.size * (1 - k * 0.2))
        out.compose(v.set(sl.x + sl.nx * 0.012, sl.y + sl.ny * 0.012, sl.z + sl.nz * 0.012), q, s)
      },
    )
    this.holes.mesh.renderOrder = 4
    for (const b of [this.tracers, this.flashes, this.puffs, this.holes]) {
      seedColors(b.mesh)
      root.add(b.mesh)
    }
    this.casingMesh = new InstancedMesh(
      new BoxGeometry(0.012, 0.012, 0.03),
      new MeshStandardMaterial({ color: 0xc8_9a_4a, metalness: 0.65, roughness: 0.35 }),
      24,
    )
    this.casingMesh.name = 'casing'
    this.casingMesh.count = 0
    this.casingMesh.frustumCulled = false
    root.add(this.casingMesh)
    const dustMat = additive(dot)
    dustMat.opacity = 0.3
    this.dustMesh = new InstancedMesh(new SphereGeometry(0.03, 4, 3), dustMat, 32)
    this.dustMesh.name = 'dust'
    this.dustMesh.frustumCulled = false
    this.dustMesh.visible = false
    root.add(this.dustMesh)
    // Money bags: a lathed sack, gold-tinted.
    const sack = new LatheGeometry(
      [
        [0, 0],
        [0.2, 0.02],
        [0.26, 0.14],
        [0.22, 0.3],
        [0.1, 0.38],
        [0.12, 0.44],
        [0, 0.46],
      ].map(([x, y]) => new Vector2(x, y)),
      10,
    )
    const bagMat = new MeshStandardMaterial({
      color: 0xff_ff_ff,
      roughness: 0.7,
      emissive: 0x6a_48_10,
      emissiveIntensity: 0.6,
    })
    sackLook(bagMat)
    this.bagMesh = new InstancedMesh(sack, bagMat, 64)
    this.bagMesh.count = 0
    this.bagMesh.name = 'bags'
    this.bagMesh.frustumCulled = false
    this.bagMesh.castShadow = false
    this.bagMesh.receiveShadow = true
    root.add(this.bagMesh)
    // Strongbox and beacon.
    const boxMat = new MeshStandardMaterial({
      color: 0x8a_5a_36,
      roughness: 0.6,
      metalness: 0.15,
      emissive: 0x40_28_00,
      emissiveIntensity: 0.4,
    })
    strongboxLook(boxMat)
    this.box = new Mesh(new BoxGeometry(1.1, 0.7, 0.7).translate(0, 0.35, 0), boxMat)
    this.box.receiveShadow = true
    this.box.visible = false
    root.add(this.box)
    this.beacon = new Mesh(
      new CylinderGeometry(0.5, 0.9, 14, 16, 1, true).translate(0, 7, 0),
      new MeshBasicMaterial({
        color: new Color(1.4, 1.0, 0.35),
        transparent: true,
        opacity: 0.22,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        forceSinglePass: true,
        toneMapped: false,
      }),
    )
    this.beacon.visible = false
    root.add(this.beacon)
    // Ground rings (instanced, tinted per instance).
    this.rings = new InstancedMesh(
      new RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({
        color: 0xff_ff_ff,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
      24,
    )
    this.rings.frustumCulled = false
    this.rings.renderOrder = 3
    this.rings.count = 0
    seedColors(this.rings)
    root.add(this.rings)
    // Aim line: a long thin flat quad from the gun toward the aim, fading out.
    const lineGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5)
    this.aimLine = new Mesh(lineGeo, additive(dot))
    ;(this.aimLine.material as MeshBasicMaterial).color.setRGB(1.2, 0.95, 0.6)
    ;(this.aimLine.material as MeshBasicMaterial).opacity = 0.35
    this.aimLine.renderOrder = 4
    root.add(this.aimLine)
  }

  shot(
    x: number,
    y: number,
    z: number,
    aim: number,
    range: number,
    color = new Color(2.4, 1.8, 0.9),
  ): void {
    const t = this.tracers.spawn()
    t.life = 0.11
    t.x = x
    t.y = y
    t.z = z
    t.dx = Math.cos(aim)
    t.dz = Math.sin(aim)
    t.len = Math.max(0.5, range)
    t.vx = 0
    t.vy = 0
    t.vz = 0
    t.color.copy(color)
    const f = this.flashes.spawn()
    f.life = 0.07
    f.x = x + Math.cos(aim) * 0.15
    f.y = y
    f.z = z + Math.sin(aim) * 0.15
    f.size = 1.1 * this.flashScale
    f.vx = 0
    f.vy = 0
    f.vz = 0
    f.color.setRGB(3, 2.2, 1)
    // A little muzzle smoke drifting off the barrel.
    const smoke = this.puffs.spawn()
    smoke.life = 0.55
    smoke.x = x + Math.cos(aim) * 0.3
    smoke.y = y
    smoke.z = z + Math.sin(aim) * 0.3
    smoke.vx = Math.cos(aim) * 0.55
    smoke.vy = 0.25
    smoke.vz = Math.sin(aim) * 0.55
    smoke.size = 0.28
    smoke.color.setRGB(0.42, 0.4, 0.36)
  }

  /** A bullet hole on a surface, its quad facing (nx, ny, nz). */
  hole(x: number, y: number, z: number, nx: number, ny: number, nz: number, size = 0.13): void {
    const h = this.holes.spawn()
    h.life = 30
    h.x = x
    h.y = y
    h.z = z
    h.nx = nx
    h.ny = ny
    h.nz = nz
    h.size = size
    h.vx = 0
    h.vy = 0
    h.vz = 0
    h.color.setRGB(1, 1, 1)
  }

  /** A brass casing from your own gun, kicked out to the side and falling to the street. */
  casing(x: number, y: number, z: number, aim: number): void {
    const c = this.casings[this.casingNext]
    this.casingNext = (this.casingNext + 1) % this.casings.length
    if (!c) {
      return
    }
    c.t = 0
    c.life = 1.4
    c.x = x
    c.y = y
    c.z = z
    const side = aim + Math.PI / 2
    const kick = 0.8 + Math.random() * 0.6
    c.vx = Math.cos(side) * kick
    c.vz = Math.sin(side) * kick
    c.vy = 1.1 + Math.random() * 0.5
    c.spin = (Math.random() - 0.5) * 18
  }

  /** A pane's shards and glass dust: pale, fast, and gone in a moment. */
  glass(x: number, y: number, z: number): void {
    for (let i = 0; i < 10; i++) {
      const p = this.puffs.spawn()
      p.life = 0.35 + Math.random() * 0.3
      p.x = x
      p.y = y
      p.z = z
      p.vx = (Math.random() - 0.5) * 4.5
      p.vy = Math.random() * 2.4
      p.vz = (Math.random() - 0.5) * 4.5
      p.size = 0.07 + Math.random() * 0.12
      p.color.setRGB(0.85, 0.95, 1)
    }
  }

  /** Dust off a wall, or blood on a hit; `y` lifts it to the shooter/target's feet. */
  impact(x: number, z: number, hit: boolean, y = 0): void {
    const eye = this.eye
    if (eye && Math.hypot(x - eye.x, z - eye.z) < 0.9) {
      return
    }
    for (let i = 0; i < (hit ? 5 : 4); i++) {
      const p = this.puffs.spawn()
      p.life = hit ? 0.35 : 0.5
      p.x = x
      p.y = y + (hit ? 1.1 : 0.9)
      p.z = z
      p.vx = (Math.random() - 0.5) * 2
      p.vy = Math.random() * 1.2
      p.vz = (Math.random() - 0.5) * 2
      p.size = hit ? 0.35 : 0.45
      if (hit) {
        p.color.setRGB(1.1, 0.08, 0.04)
      } else {
        p.color.setRGB(0.5, 0.42, 0.3)
      }
    }
  }

  /** A dust gust across the street: weather without a particle system of its own. */
  gust(cx: number, cz: number): void {
    const angle = Math.random() * Math.PI * 2
    const dx = Math.cos(angle)
    const dz = Math.sin(angle)
    for (let i = 0; i < 18; i++) {
      const p = this.puffs.spawn()
      p.life = 1.1 + Math.random() * 0.9
      p.x = cx + (Math.random() - 0.5) * 14 - dx * 8
      p.y = 0.12 + Math.random() * 0.7
      p.z = cz + (Math.random() - 0.5) * 14 - dz * 8
      p.vx = dx * (4 + Math.random() * 3)
      p.vy = 0.1 + Math.random() * 0.25
      p.vz = dz * (4 + Math.random() * 3)
      p.size = 0.3 + Math.random() * 0.3
      p.color.setRGB(0.55, 0.45, 0.33)
    }
  }

  /** A burst of gold (pickups, deposits, strongbox). */
  sparkle(x: number, z: number, n = 10): void {
    for (let i = 0; i < n; i++) {
      const p = this.puffs.spawn()
      p.life = 0.6
      p.x = x
      p.y = 0.6
      p.z = z
      p.vx = (Math.random() - 0.5) * 3
      p.vy = 1.5 + Math.random() * 2
      p.vz = (Math.random() - 0.5) * 3
      p.size = 0.22
      p.color.setRGB(2.2, 1.6, 0.4)
    }
  }

  /** Dust kicked up by a roll, a fall or a respawn. */
  dust(x: number, z: number, n = 6): void {
    for (let i = 0; i < n; i++) {
      const p = this.puffs.spawn()
      p.life = 0.7
      p.x = x + (Math.random() - 0.5) * 0.6
      p.y = 0.2
      p.z = z + (Math.random() - 0.5) * 0.6
      p.vx = (Math.random() - 0.5) * 1.4
      p.vy = 0.5 + Math.random() * 0.5
      p.vz = (Math.random() - 0.5) * 1.4
      p.size = 0.7
      p.color.setRGB(0.35, 0.3, 0.22)
    }
  }

  /** One fizzing spark from a lit fuse. */
  spark(x: number, y: number, z: number): void {
    const p = this.puffs.spawn()
    p.life = 0.18
    p.x = x
    p.y = y
    p.z = z
    p.vx = (Math.random() - 0.5) * 1.5
    p.vy = 1 + Math.random()
    p.vz = (Math.random() - 0.5) * 1.5
    p.size = 0.16
    p.color.setRGB(3, 2, 0.6)
  }

  /** Dynamite: a fireball, a flash and a ring of dust (4 m). */
  explosion(x: number, z: number): void {
    const f = this.flashes.spawn()
    f.life = 0.18
    f.x = x
    f.y = 0.6
    f.z = z
    f.size = 9
    f.vx = 0
    f.vy = 0
    f.vz = 0
    f.color.setRGB(4, 2.4, 0.8)
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2
      const sp = 3 + Math.random() * 4
      const p = this.puffs.spawn()
      p.life = 0.5 + Math.random() * 0.5
      p.x = x
      p.y = 0.4
      p.z = z
      p.vx = Math.cos(a) * sp
      p.vy = 0.5 + Math.random() * 2.5
      p.vz = Math.sin(a) * sp
      p.size = 1 + Math.random() * 0.8
      const hot = i % 3 === 0
      p.color.setRGB(hot ? 2.6 : 0.5, hot ? 1.2 : 0.42, hot ? 0.3 : 0.32)
    }
  }

  /** A shotgun shell: eight short pellet tracers fanned over the cone. */
  pellets(x: number, y: number, z: number, aim: number, range: number, coneRad: number): void {
    for (let i = 0; i < 8; i++) {
      const a = aim + ((i / 7) * 2 - 1) * coneRad * (0.7 + Math.random() * 0.3)
      const t = this.tracers.spawn()
      t.life = 0.09
      t.x = x
      t.y = y
      t.z = z
      t.dx = Math.cos(a)
      t.dz = Math.sin(a)
      t.len = range * (0.75 + Math.random() * 0.25)
      t.vx = 0
      t.vy = 0
      t.vz = 0
      t.color.setRGB(2.2, 1.5, 0.7)
    }
    const f = this.flashes.spawn()
    f.life = 0.09
    f.x = x + Math.cos(aim) * 0.2
    f.y = y
    f.z = z + Math.sin(aim) * 0.2
    f.size = 1.8 * this.flashScale
    f.vx = 0
    f.vy = 0
    f.vz = 0
    f.color.setRGB(3, 2, 0.9)
  }

  throwHat(hat: Group, dirX: number, dirZ: number): void {
    this.root.attach(hat)
    this.hats.push({
      g: hat,
      vx: dirX * 3,
      vy: 4,
      vz: dirZ * 3,
      spin: (Math.random() - 0.5) * 20,
      t: 0,
    })
  }

  setStrongbox(x: number, z: number, on: boolean, opening: boolean): void {
    this.box.visible = on
    this.beacon.visible = on
    if (on) {
      this.box.position.set(x, 0, z)
      this.beacon.position.set(x, 0, z)
      ;(this.beacon.material as MeshBasicMaterial).opacity = opening ? 0.4 : 0.2
    }
  }

  /** Rings for this frame: call `ring` any number of times between `beginRings` and `update`. */
  beginRings(): void {
    this.ringCount = 0
  }

  ring(x: number, z: number, r: number, color: Color, pulse = 0): void {
    const e = this.ringList[this.ringCount]
    if (e) {
      this.ringCount++
      e.x = x
      e.z = z
      e.r = r
      e.color = color
      e.pulse = pulse
    }
  }

  /** Turn the ambient dust field on (high tier only). */
  showDust(on: boolean): void {
    this.dustMesh.visible = on
  }

  /** Slow motes around the player, so the window shafts have something to catch. */
  private updateDust(dt: number): void {
    if (!this.dustMesh.visible) {
      return
    }
    this.dustTime += dt
    q.identity()
    for (const [i, seed] of this.dustSeeds.entries()) {
      const x = this.dustFocus.x + seed.ox + Math.sin(this.dustTime * 0.25 + seed.phase) * 0.5
      const y = seed.oy + Math.sin(this.dustTime * 0.18 + seed.phase * 1.7) * 0.22
      const z = this.dustFocus.z + seed.oz + Math.cos(this.dustTime * 0.21 + seed.phase) * 0.5
      s.setScalar(0.02 + (i % 3) * 0.008)
      m4.compose(v.set(x, y, z), q, s)
      this.dustMesh.setMatrixAt(i, m4)
    }
    this.dustMesh.instanceMatrix.needsUpdate = true
  }

  /** Fall, bounce and settle this frame's shell casings. */
  private updateCasings(dt: number): void {
    let cn = 0
    for (const c of this.casings) {
      if (c.t >= c.life) {
        continue
      }
      c.t += dt
      c.vy -= 9.8 * dt
      c.x += c.vx * dt
      c.y += c.vy * dt
      c.z += c.vz * dt
      if (c.y < 0.02) {
        c.y = 0.02
        c.vy = -c.vy * 0.3
        c.vx *= 0.55
        c.vz *= 0.55
      }
      q.setFromAxisAngle(up, c.spin * c.t)
      s.setScalar(1)
      m4.compose(v.set(c.x, c.y, c.z), q, s)
      this.casingMesh.setMatrixAt(cn, m4)
      cn++
    }
    this.casingMesh.count = cn
    this.casingMesh.visible = cn > 0
    if (cn > 0) {
      this.casingMesh.instanceMatrix.needsUpdate = true
    }
  }

  update(dt: number, bobT: number): void {
    this.time += dt
    this.tracers.update(dt)
    this.flashes.update(dt)
    this.puffs.update(dt)
    this.holes.update(dt)
    this.updateDust(dt)
    this.updateCasings(dt)
    let i = 0
    for (const b of this.bags.values()) {
      if (i >= 64) {
        break
      }
      const k = Math.min(1, (bobT - b.born) * 4)
      const scale = (0.75 + Math.min(1.2, Math.sqrt(b.amount / 100)) * 0.5) * k
      q.setFromAxisAngle(up, bobT * 1.4 + b.id)
      // a gentle hover over the dirt that never dips into it (it bobbed 1 cm under the ground)
      m4.compose(v.set(b.x, 0.07 + Math.sin(bobT * 3 + b.id) * 0.06, b.z), q, s.setScalar(scale))
      this.bagMesh.setColorAt(i, bagTint.setHex(b.color ?? PLAIN_BAG))
      this.bagMesh.setMatrixAt(i++, m4)
    }
    if (this.bagMesh.instanceColor) {
      this.bagMesh.instanceColor.needsUpdate = true
    }
    this.bagMesh.count = i
    this.bagMesh.instanceMatrix.needsUpdate = true
    let n = 0
    for (const r of this.ringList) {
      if (n >= this.ringCount) {
        break
      }
      const pulse = r.pulse > 0 ? 1 + Math.sin(this.time * r.pulse) * 0.08 : 1
      m4.compose(
        v.set(r.x, 0.045 + n * 0.001, r.z),
        q.identity(),
        s.set(r.r * pulse, 1, r.r * pulse),
      )
      this.rings.setMatrixAt(n, m4)
      this.rings.setColorAt(n, r.color)
      n++
    }
    this.rings.count = n
    this.rings.instanceMatrix.needsUpdate = true
    if (this.rings.instanceColor) {
      this.rings.instanceColor.needsUpdate = true
    }
    if (this.box.visible) {
      this.box.rotation.y += dt * 0.3
    }
    for (const h of [...this.hats]) {
      h.t += dt
      if (h.g.position.y > 0.05 || h.vy > 0) {
        h.vy -= 14 * dt
        h.g.position.x += h.vx * dt
        h.g.position.y = Math.max(0.03, h.g.position.y + h.vy * dt)
        h.g.position.z += h.vz * dt
        h.g.rotation.x += h.spin * dt
        if (h.g.position.y <= 0.03) {
          h.vy = 0
          h.vx = 0
          h.vz = 0
          h.spin = 0
          h.g.rotation.x = 0
          h.g.rotation.z = 0.1
        }
      }
      if (h.t > 6) {
        h.g.removeFromParent()
        this.hats.splice(this.hats.indexOf(h), 1)
      }
    }
  }

  /** Own aim line from (x, z) along `aim`, `len` metres (null hides it). */
  setAimLine(x: number, z: number, aim: number, len: number | null, strong: boolean): void {
    const l = this.aimLine
    l.visible = len !== null
    if (len === null) {
      return
    }
    l.position.set(x, 1.2, z)
    l.rotation.set(0, Math.atan2(-Math.cos(aim), -Math.sin(aim)), 0)
    l.scale.set(strong ? 0.08 : 0.05, 1, len)
    ;(l.material as MeshBasicMaterial).opacity = strong ? 0.6 : 0.28
  }
}
