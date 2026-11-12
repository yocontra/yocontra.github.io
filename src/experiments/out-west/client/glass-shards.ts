import {
  type Asset,
  BLEND_NORMAL,
  BODYGROUP_STATIC,
  BODYGROUP_USER_2,
  CULLFACE_NONE,
  Entity,
  type Material,
  Mesh,
  MeshInstance,
  Quat,
  StandardMaterial,
  Vec3,
} from 'playcanvas'
import type { GlassPlane } from '../ffa/sim/building-rules.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { Simulation } from '../runtime/world.ts'
import { getSettings } from '../settings.ts'
import type { GameApplication } from './application.ts'
import type { NativeRagdolls } from './ragdolls.ts'

/** Whole-town ceiling on live shard bodies: a shotgun through a shopfront stays cheap on phones. */
const MAX_SHARDS = 63
const RAYS = 7
const RINGS = [0.22, 0.55] as const
const FALL_SECONDS = 2.4
const FADE_SECONDS = 0.45
/** `glass_shatter.m4a` holds two takes on a 2.5 s grid. */
const TAKES = 2
const TAKE_STEP = 2.5
const TAKE_SECONDS = 2.2

type Point2 = readonly [number, number]
interface Shard {
  body: Entity
  /** Convex outline in the body's frame: x along the pane, y up. */
  outline: Vec3[]
  /** Seconds this piece stays wedged in the frame before it drops; 0 once it falls. */
  hold: number
}
interface Burst {
  index: number
  entity: Entity
  mesh: Mesh
  shards: Shard[]
  positions: Float32Array
  normals: Float32Array
  seconds: number
}
interface Strike {
  origin: { x: number; y: number; z: number }
  end: { x: number; y: number; z: number }
}
export interface PaneSource {
  plane: (index: number) => GlassPlane | undefined
  material: (index: number) => Material | undefined
  hide: (index: number) => void
}

function random(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}
function exit(origin: number, direction: number, size: number): number {
  if (direction > 0) {
    return (size - origin) / direction
  }
  return direction < 0 ? -origin / direction : Number.POSITIVE_INFINITY
}
function boundary(origin: Point2, angle: number, size: Point2): Point2 {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const t = Math.min(exit(origin[0], dx, size[0]), exit(origin[1], dy, size[1]))
  return [origin[0] + dx * t, origin[1] + dy * t]
}
function turn(from: number, to: number): number {
  const tau = Math.PI * 2
  return (((to - from) % tau) + tau) % tau
}
function cornersBetween(from: number, to: number, origin: Point2, size: Point2): Point2[] {
  const corners: Point2[] = [
    [size[0], size[1]],
    [0, size[1]],
    [0, 0],
    [size[0], 0],
  ]
  const span = turn(from, to)
  return corners
    .map((corner) => ({
      corner,
      turn: turn(from, Math.atan2(corner[1] - origin[1], corner[0] - origin[0])),
    }))
    .filter((entry) => entry.turn > 0 && entry.turn < span)
    .sort((a, b) => a.turn - b.turn)
    .map((entry) => entry.corner)
}

/**
 * Radial fracture of a `width` × `height` pane around the strike: an inner fan, a ring of quads and
 * the outer pieces out to the frame. Every piece is convex and together they tile the pane.
 */
export function fracture(width: number, height: number, strike: Point2, seed: number): Point2[][] {
  const next = random(seed)
  const size: Point2 = [width, height]
  const origin: Point2 = [
    Math.min(width * 0.9, Math.max(width * 0.1, strike[0])),
    Math.min(height * 0.9, Math.max(height * 0.1, strike[1])),
  ]
  const start = next() * Math.PI * 2
  const rays = Array.from({ length: RAYS }, (_, i) => {
    const angle = start + ((i + 0.2 + next() * 0.6) / RAYS) * Math.PI * 2
    const edge = boundary(origin, angle, size)
    const ring = RINGS.map((fraction): Point2 => {
      const t = fraction * (0.8 + next() * 0.4)
      return [origin[0] + (edge[0] - origin[0]) * t, origin[1] + (edge[1] - origin[1]) * t]
    })
    return { angle, edge, inner: ring[0] ?? origin, outer: ring[1] ?? edge }
  })
  return rays.flatMap((ray, i) => {
    const after = rays[(i + 1) % RAYS] ?? ray
    return [
      [origin, ray.inner, after.inner],
      [ray.inner, ray.outer, after.outer, after.inner],
      [
        ray.outer,
        ray.edge,
        ...cornersBetween(ray.angle, after.angle, origin, size),
        after.edge,
        after.outer,
      ],
    ]
  })
}

const vertex = [new Vec3(), new Vec3(), new Vec3()] as const
const edgeA = new Vec3()
const edgeB = new Vec3()
const normal = new Vec3()
const scaled = new Vec3()
const spin = new Quat()

/** Bake every shard's native body transform into the burst's one dynamic mesh. */
function bake(burst: Burst): void {
  const shrink = Math.max(0, Math.min(1, 1 - (burst.seconds - FALL_SECONDS) / FADE_SECONDS))
  let offset = 0
  for (const shard of burst.shards) {
    const transform = shard.body.getWorldTransform()
    for (let fan = 1; fan < shard.outline.length - 1; fan++) {
      const triangle = [shard.outline[0], shard.outline[fan], shard.outline[fan + 1]]
      for (const [slot, point] of triangle.entries()) {
        transform.transformPoint(scaled.copy(point ?? Vec3.ZERO).mulScalar(shrink), vertex[slot])
      }
      normal.cross(edgeA.sub2(vertex[1], vertex[0]), edgeB.sub2(vertex[2], vertex[0])).normalize()
      for (const point of vertex) {
        burst.positions.set([point.x, point.y, point.z], offset)
        burst.normals.set([normal.x, normal.y, normal.z], offset)
        offset += 3
      }
    }
  }
  burst.mesh.setPositions(burst.positions)
  burst.mesh.setNormals(burst.normals)
  burst.mesh.update()
}
/**
 * A shattered pane bursts into native rigid shards in the shared presentation Ammo world. They
 * collide with the town only, settle, shrink away and free their bodies; never more than
 * `MAX_SHARDS` at once.
 */
export class GlassShards {
  private readonly game: GameApplication
  private readonly simulation: Simulation
  private readonly panes: PaneSource
  private readonly materials = new Map<Material | null, StandardMaterial>()
  private readonly bursts: Burst[] = []
  private readonly strikes: Strike[] = []
  private readonly breaks: number[] = []
  private readonly speaker: Entity
  private sound: Asset | undefined
  private seed = 1
  constructor(game: GameApplication, ragdolls: NativeRagdolls, panes: PaneSource) {
    this.game = game
    this.simulation = ragdolls.share(() => this.active)
    this.panes = panes
    this.speaker = new Entity('glass-shatter', game.app)
    this.speaker.addComponent('sound', { positional: true, refDistance: 4, maxDistance: 55 })
    for (let take = 0; take < TAKES; take++) {
      this.speaker.sound?.addSlot(`take${take}`, {
        overlap: true,
        startTime: take * TAKE_STEP,
        duration: TAKE_SECONDS,
      })
    }
    game.stage.addChild(this.speaker)
    game
      .loadAudio('/experiments/out-west/3d/sfx/glass_shatter.m4a')
      .then((asset) => {
        this.sound = asset
        for (let take = 0; take < TAKES; take++) {
          const slot = this.speaker.sound?.slot(`take${take}`)
          if (slot) {
            slot.asset = asset.id
          }
        }
      })
      .catch(() => undefined)
    game.app.on('update', this.update)
    game.app.on('prerender', this.pose)
  }
  get active(): boolean {
    return this.bursts.length > 0
  }
  event(event: SimEvent): void {
    if (event.type === 'shot') {
      for (const end of [event.end, ...event.pellets]) {
        this.strikes.push({ origin: event.origin, end })
      }
    } else if (event.type === 'glass_break') {
      this.breaks.push(event.window)
    }
  }
  stats(): { bursts: number; shards: number } {
    return {
      bursts: this.bursts.length,
      shards: this.bursts.reduce((count, burst) => count + burst.shards.length, 0),
    }
  }
  private readonly update = (dt: number): void => {
    for (const index of this.breaks.splice(0)) {
      this.shatter(index)
    }
    this.strikes.length = 0
    for (const burst of this.bursts) {
      burst.seconds += Math.min(0.1, dt)
      for (const shard of burst.shards) {
        const body = shard.body.rigidbody
        if (shard.hold > 0 && burst.seconds >= shard.hold && body) {
          shard.hold = 0
          body.type = 'dynamic'
          body.linearVelocity = new Vec3(0, -0.3, 0)
        }
      }
    }
    while (this.bursts[0] && this.bursts[0].seconds >= FALL_SECONDS + FADE_SECONDS) {
      this.retire(0)
    }
  }
  /** Where a bullet crossed this pane (pane coordinates) and which side it pushes the glass to. */
  private strike(plane: GlassPlane): { at: Point2; push: number } {
    for (const { origin, end } of this.strikes) {
      const from = plane.axis === 0 ? origin.x : origin.z
      const to = plane.axis === 0 ? end.x : end.z
      if (from === to || (from - plane.at) * (to - plane.at) > 0) {
        continue
      }
      const t = (plane.at - from) / (to - from)
      const along =
        plane.axis === 0 ? origin.z + (end.z - origin.z) * t : origin.x + (end.x - origin.x) * t
      const y = origin.y + (end.y - origin.y) * t
      if (along >= plane.a0 - 0.2 && along <= plane.a1 + 0.2) {
        return { at: [along - plane.a0, y - plane.y0], push: Math.sign(to - from) }
      }
    }
    // A rider crashing through: burst away from the nearest camera side, at chest height.
    const eye = this.game.camera.getPosition()
    return {
      at: [(plane.a1 - plane.a0) / 2, (plane.y1 - plane.y0) * 0.45],
      push: (plane.axis === 0 ? eye.x : eye.z) < plane.at ? 1 : -1,
    }
  }
  private shatter(index: number): void {
    const plane = this.panes.plane(index)
    if (!plane || this.bursts.some((burst) => burst.index === index)) {
      return
    }
    this.panes.hide(index)
    this.seed = (Math.imul(this.seed, 31) + index + 1) | 0
    const width = plane.a1 - plane.a0
    const height = plane.y1 - plane.y0
    const { at, push } = this.strike(plane)
    const pieces = fracture(width, height, at, this.seed)
    while (this.bursts.length > 0 && this.stats().shards + pieces.length > MAX_SHARDS) {
      this.retire(0)
    }
    const next = random(this.seed ^ 0x5b_d1_e9_95)
    const along = new Vec3(plane.axis === 0 ? 0 : 1, 0, plane.axis === 0 ? 1 : 0)
    const across = new Vec3(plane.axis === 0 ? push : 0, 0, plane.axis === 0 ? 0 : push)
    const place = (u: number, v: number) =>
      new Vec3(
        plane.axis === 0 ? plane.at : plane.a0 + u,
        plane.y0 + v,
        plane.axis === 0 ? plane.a0 + u : plane.at,
      )
    const shards = pieces.map((piece): Shard => {
      const cu = piece.reduce((sum, point) => sum + point[0], 0) / piece.length
      const cv = piece.reduce((sum, point) => sum + point[1], 0) / piece.length
      const outline = piece.map((point) => new Vec3(point[0] - cu, point[1] - cv, 0))
      const edge = Math.min(cu, cv, width - cu, height - cv) < 0.14
      const hold = edge && next() < 0.45 ? 0.2 + next() * 1.2 : 0
      const body = this.body(place(cu, cv), plane, outline, hold)
      const rigid = body.rigidbody
      if (rigid && hold === 0) {
        const burst = Math.max(0.5, 3 - Math.hypot(cu - at[0], cv - at[1]) * 2.5)
        rigid.linearVelocity = across
          .clone()
          .mulScalar(burst * (0.6 + next() * 0.8))
          .add(along.clone().mulScalar((cu - at[0]) * 1.5 * next()))
          .add(new Vec3(0, (cv - at[1]) * 1.1 + next() * 0.5, 0))
        rigid.angularVelocity = new Vec3(next() * 14 - 7, next() * 14 - 7, next() * 14 - 7)
      }
      return { body, outline, hold }
    })
    this.bursts.push(this.burst({ index, shards, plane, width, height }))
    this.play(place(at[0], at[1]))
  }
  private body(position: Vec3, plane: GlassPlane, outline: Vec3[], hold: number): Entity {
    const halfU = Math.max(0.015, ...outline.map((point) => Math.abs(point.x)))
    const halfV = Math.max(0.015, ...outline.map((point) => Math.abs(point.y)))
    const body = new Entity('glass-shard', this.simulation.app)
    body.setPosition(position)
    body.setRotation(spin.setFromAxisAngle(Vec3.UP, plane.axis === 0 ? -90 : 0))
    body.addComponent('collision', { type: 'box', halfExtents: new Vec3(halfU, halfV, 0.008) })
    body.addComponent('rigidbody', {
      type: hold > 0 ? 'kinematic' : 'dynamic',
      // 4 mm crown glass: about 10 kg per square metre.
      mass: Math.max(0.02, halfU * halfV * 40),
      friction: 0.6,
      restitution: 0.2,
      linearDamping: 0.05,
      angularDamping: 0.25,
      group: BODYGROUP_USER_2,
      mask: BODYGROUP_STATIC,
    })
    this.simulation.app.root.addChild(body)
    // Thin falling slivers sweep against the town instead of tunnelling through floor triangles.
    body.rigidbody?.body?.setCcdMotionThreshold?.(0.02)
    body.rigidbody?.body?.setCcdSweptSphereRadius?.(0.008)
    return body
  }
  private burst(options: {
    index: number
    shards: Shard[]
    plane: GlassPlane
    width: number
    height: number
  }): Burst {
    const { index, shards, plane, width, height } = options
    const uvs: number[] = []
    for (const shard of shards) {
      const centre = shard.body.getPosition()
      const cu = (plane.axis === 0 ? centre.z : centre.x) - plane.a0
      const cv = centre.y - plane.y0
      for (let fan = 1; fan < shard.outline.length - 1; fan++) {
        for (const point of [shard.outline[0], shard.outline[fan], shard.outline[fan + 1]]) {
          uvs.push(((point?.x ?? 0) + cu) / width, 1 - ((point?.y ?? 0) + cv) / height)
        }
      }
    }
    const vertices = uvs.length / 2
    const positions = new Float32Array(vertices * 3)
    const normals = new Float32Array(vertices * 3)
    const mesh = new Mesh(this.game.app.graphicsDevice)
    mesh.setPositions(positions)
    mesh.setNormals(normals)
    mesh.setUvs(0, uvs)
    mesh.update()
    const entity = new Entity(`glass-burst-${index}`, this.game.app)
    entity.addComponent('render', {
      meshInstances: [new MeshInstance(mesh, this.material(this.panes.material(index)))],
      castShadows: false,
    })
    this.game.stage.addChild(entity)
    const burst = { index, entity, mesh, shards, positions, normals, seconds: 0 }
    bake(burst)
    return burst
  }
  /** The pane's own authored glass, a little denser so thin slivers still catch the light. */
  private material(source: Material | undefined): StandardMaterial {
    const key = source ?? null
    const cached = this.materials.get(key)
    if (cached) {
      return cached
    }
    const material =
      source instanceof StandardMaterial
        ? (source.clone() as StandardMaterial)
        : new StandardMaterial()
    material.blendType = BLEND_NORMAL
    material.opacity = Math.min(0.6, Math.max(0.36, material.opacity * 1.5))
    material.cull = CULLFACE_NONE
    material.depthWrite = false
    material.update()
    this.materials.set(key, material)
    return material
  }
  private play(at: Vec3): void {
    const manager = this.game.app.soundManager
    const sound = this.speaker.sound
    if (!(this.sound && sound) || manager.suspended || manager.context?.state !== 'running') {
      return
    }
    this.speaker.setPosition(at)
    const name = `take${Math.floor(Math.random() * TAKES)}`
    const slot = sound.slot(name)
    if (slot) {
      slot.volume = getSettings().sfx * 0.85
      slot.pitch = 0.94 + Math.random() * 0.12
    }
    sound.play(name)
  }
  private readonly pose = (): void => {
    for (const burst of this.bursts) {
      bake(burst)
    }
  }
  private retire(index: number): void {
    const [burst] = this.bursts.splice(index, 1)
    if (!burst) {
      return
    }
    for (const shard of burst.shards) {
      shard.body.destroy()
    }
    burst.entity.destroy()
    burst.mesh.destroy()
  }
  reset(): void {
    while (this.bursts.length > 0) {
      this.retire(0)
    }
    this.breaks.length = 0
    this.strikes.length = 0
  }
  destroy(): void {
    this.game.app.off('update', this.update)
    this.game.app.off('prerender', this.pose)
    this.reset()
    this.speaker.destroy()
    for (const material of this.materials.values()) {
      material.destroy()
    }
    this.materials.clear()
  }
}
