// biome-ignore-all lint/complexity/useMaxParams: per-frame hot paths take positional numbers to avoid allocating
// biome-ignore-all lint/style/useThisInClassMethods: private helpers kept on the class next to the state they describe
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the near/far crowd is one system (ranking, LOD swaps, actors, VAT instances, hats, blobs)
/**
 * Everyone in the Frontier, drawn within the A15 budget (spec §9.3, stream H's measured design):
 *
 * - The nearest `near` players (8 on the floor tier, 16 above; your own player always) are
 *   GPU-skinned Actors. Yours stays at LOD0; the rest swap to a meshopt LOD1 (`scene/lod.ts`).
 *   Animation runs at 30 Hz within 12 m and 15 Hz beyond. Only the nearest `casters` (4 on floor,
 *   6 above) cast real shadows.
 * - Everyone else is a VAT instance of their base body (≤7 bases, one draw each), tinted per
 *   instance with their palette, with hats as one instanced draw per hat type on the baked head
 *   track, and one draw of blob shadows for everyone who isn't casting.
 *
 * Actors are built lazily (at most one per frame) and kept for players who stay around; until a
 * player's actor exists they're drawn as a VAT instance, so nobody ever pops out.
 */
import {
  type BufferGeometry,
  CanvasTexture,
  type Color,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  type Scene,
  type SkinnedMesh,
  Vector3,
} from 'three'
import {
  ANIM_AIM,
  ANIM_DEAD,
  ANIM_ROLL,
  EF_HATLESS,
  EF_HOLSTERED,
  EF_PROTECTED,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import type { BodyKey } from '../../data/outlaws.ts'
import type { Assets } from '../../engine/assets.ts'
import type { Actor, Clip } from '../../scene/actor.ts'
import { castActor } from '../../scene/cast.ts'
import { lodGeometry } from '../../scene/lod.ts'
import type { LongHold } from '../../scene/longgun.ts'
import { propDef, propObject } from '../../scene/props.ts'
import { rifleObject } from '../../scene/rifle.ts'
import { RIFLE_ROUNDS, SHOTGUN_SHELLS } from '../sim/constants.ts'
import { holdSkin } from './crowd/skin-hold.ts'
import {
  baseVat,
  headAt,
  VAT_TIME,
  type VatBake,
  VatCrowd,
  VatHats,
  vatFrame,
} from './crowd/vat.ts'
import { shareDepthByKind } from './depth-kinds.ts'
import { Locomotion } from './locomotion.ts'
import type { PlayerLook } from './looks.ts'
import { kitMaterial, shotgunMesh } from './shotgun.ts'

const VAT_CLIPS: Clip[] = ['Idle', 'Walk', 'Run', 'Idle_Gun_Pointing', 'Death']
const NEAR_FAST_M = 12
const SHADOW_CASTERS = 6
const LOD1_TRIS = 3000
/** Triangles in a skinned (near) rider's hat, other than yours. */
const NEAR_HAT_TRIS = 800
/** Running speed the Run clip was authored for (m/s). */
const CLIP_RUN_SPEED = 5.2
/** Walking speed the Walk clip was authored for (m/s), until an actor measures his stride. */
const CLIP_WALK_SPEED = 1.4
/**
 * Gait thresholds on the smoothed ground speed (m/s), with hysteresis so a rider near a boundary
 * doesn't flicker between clips: idle below `WALK_ON` (back to idle under `WALK_OFF`), walk up to
 * `RUN_ON` (back from a run under `RUN_OFF`). A full stick runs at 5.5 m/s.
 */
const WALK_ON = 0.45
const WALK_OFF = 0.25
const RUN_ON = 2.6
const RUN_OFF = 2.1
/** How fast the drawn ground speed follows the snapshots' (1/s). */
const SPEED_EASE = 10
const GAIT_IDLE = 0
const GAIT_WALK = 1
const GAIT_RUN = 2
/**
 * Built actors kept beyond the skinned cap. A parked actor (off the graph) costs nothing per frame,
 * only its geometry and bones in memory, while re-casting one is a full dress-and-bake plus a GPU
 * upload (a frame spike); so riders who drift out and back in keep theirs.
 */
const MAX_ACTORS_EXTRA = 20
/** An actor whose rider has been out of interest this long is freed even under the cap (s). */
const PARK_S = 90
/** Players this many ranks beyond the skinned cap get their actor built ahead of time. */
const PREBUILD_RING = 4
/** Characters read 25% bigger than life from the top-down camera (visual only; collision is the sim's). */
export const READ_SCALE = 1.25
/** Map weapons: how big they read (the coach gun a touch heavier than life, to read from the sky). */
const SHOTGUN_HELD_SCALE = 1.15

/** What the crowd needs to know about one player this frame. */
export interface CrowdPlayer {
  id: number
  x: number
  z: number
  /** Radians, 0 = +x, increasing toward +z. */
  aim: number
  vx: number
  vz: number
  anim: number
  /** `STANCE_*` bits: crouched, on the sights, sprinting. */
  stance: number
  /** Aim pitch (rad, up positive), when known (your own rider). */
  pitch?: number
  flags: number
  self: boolean
  /** `WEAPON_*` in hand, when known for sure (your own, from the self block). */
  weapon?: number
}

/** A map weapon shouldered in both hands (scene/longgun.ts; barrel along its +X). */
type LongGun = LongHold

interface Member {
  id: number
  look: PlayerLook
  actor: Actor | null
  holder: Group | null
  pivot: Group | null
  full: BufferGeometry | null
  lod1: BufferGeometry | null
  /** His animation state machine (scene/locomotion.ts), once his actor exists. */
  loco: Locomotion | null
  /** When he last fired (s), so his gun arm stays up a moment. */
  shotAt: number
  acc: number
  wasNear: boolean
  phase: number
  anim: number
  animSince: number
  lastSeen: number
  /** Distance rank this frame (0 = you); unranked members (out of interest) are Infinity. */
  rank: number
  /** Ground speed as drawn (m/s): the snapshots' speed, eased. */
  speed: number
  /** `GAIT_*`: idle, walk or run, from `speed` with hysteresis (every LOD reads it). */
  gait: number
  caster: boolean
  recoil: number
  /**
   * `WEAPON_*` he holds, as the events tell it (only your own is in the snapshot): a map weapon
   * from his pickup, a shot's flags, its rounds counted down; back to the revolver when they run
   * out, or he dies.
   */
  weapon: number
  rounds: number
  shotgun: LongGun | null
  rifle: LongGun | null
  /** The map weapon in his hand right now, if any (for the muzzle). */
  held: LongGun | null
  /**
   * His rig's bones. They only move when his mixer ticks (30 or 15 Hz), so their local matrices
   * are composed then, not by every frame's scene-graph walk.
   */
  bones: Object3D[]
  /** Marks his bone textures for a rebuild at the next draw (`crowd/skin-hold.ts`). */
  skin: (() => void)[]
}

function blobTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(0,0,0,0.5)')
    g.addColorStop(0.55, 'rgba(0,0,0,0.24)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  return new CanvasTexture(c)
}

const facing = (aim: number): number => Math.PI / 2 - aim

const m4 = new Matrix4()
const headM = new Matrix4()
const hatM = new Matrix4()
const q = new Quaternion()
const hq = new Quaternion()
const hp = new Vector3()
const pos = new Vector3()
const one = new Vector3(1, 1, 1)
const up = new Vector3(0, 1, 0)

export class Crowd {
  readonly root = new Group()
  private readonly scene: Scene
  private readonly assets: Assets
  private readonly members = new Map<number, Member>()
  private readonly vats = new Map<BodyKey, VatCrowd>()
  private readonly vatLoading = new Set<BodyKey>()
  private readonly hats: VatHats
  private readonly hatLocal = new Map<BodyKey, Matrix4>()
  private readonly blobs: InstancedMesh
  readonly ring: Mesh
  private readonly gun: Group | null
  private readonly kit: Material
  /** Skinned cap (8 floor, 6 legacy, 16 medium/high). */
  near: number
  /** Skinned riders casting real shadows, nearest first (the rest get a blob). */
  casters = SHADOW_CASTERS
  /**
   * How big characters read: 1.25 from the top-down camera, life size (1) at eye level, where a
   * bigger-than-life rider would tower over the doors. Set by the game's view mode.
   */
  readScale = READ_SCALE
  /** First person (or a lens pulled into your head): your own body isn't drawn. */
  hideSelf = false
  private readonly order: CrowdPlayer[] = []
  /** Ids drawn this frame (reused). */
  private readonly seen = new Set<number>()
  stats = { near: 0, far: 0, actors: 0, casters: 0, builds: 0 }
  /** Actors cast so far (each is a full dress-and-bake; churn here is the crowd's main CPU cost). */
  private builds = 0

  constructor(scene: Scene, assets: Assets, near: number) {
    this.scene = scene
    this.assets = assets
    this.near = near
    this.root.name = 'crowd'
    scene.add(this.root)
    this.hats = new VatHats(this.root, 40)
    this.blobs = new InstancedMesh(
      new PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
      40,
    )
    this.blobs.frustumCulled = false
    this.blobs.renderOrder = 1
    this.blobs.count = 0
    this.root.add(this.blobs)
    this.ring = new Mesh(
      new RingGeometry(0.55, 0.68, 40).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({
        color: 0xff_d0_60,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    )
    this.ring.renderOrder = 2
    this.root.add(this.ring)
    const def = propDef(assets.props, 'revolver', 0.32)
    this.kit = kitMaterial(assets.props)
    this.gun = def ? propObject(def) : null
    // the revolver is a loose mesh too: the kit twin, not the town's instanced kit material
    this.gun?.traverse((o) => {
      if (o instanceof Mesh && !Array.isArray(o.material) && o.material.name === 'Kit') {
        o.material = this.kit
      }
    })
  }

  /** He took a map weapon (`EV_PICKUP_TAKEN` of a shotgun or rifle spot). */
  armed(id: number, weapon: number): void {
    const m = this.members.get(id)
    if (m) {
      m.weapon = weapon
      m.rounds = weapon === WEAPON_SHOTGUN ? SHOTGUN_SHELLS : RIFLE_ROUNDS
    }
  }

  /** He fired (`EV_SHOT` flags): the gun it came from, a map weapon's round spent. */
  fired(id: number, flags: number): void {
    const m = this.members.get(id)
    if (!m) {
      return
    }
    m.shotAt = performance.now() / 1000
    let w = WEAPON_REVOLVER
    if (flags & SHOT_SHOTGUN) {
      w = WEAPON_SHOTGUN
    } else if (flags & SHOT_RIFLE) {
      w = WEAPON_RIFLE
    }
    if (w !== m.weapon) {
      // joined late or missed the pickup: assume a fresh one
      this.armed(id, w)
    }
    if (w !== WEAPON_REVOLVER) {
      m.rounds--
      if (m.rounds <= 0) {
        m.weapon = WEAPON_REVOLVER
      }
    }
  }

  /** He took a hit from (`fx`, `fz`) (null: unknown): a flinch and a hit clip. */
  hurt(id: number, at: { x: number; z: number }, from: { x: number; z: number } | null): void {
    const m = this.members.get(id)
    if (m?.loco) {
      m.loco.hit(from ? at.x - from.x : 0, from ? at.z - from.z : 0)
    }
  }

  /** He was killed from (`fx`, `fz`) (null: unknown): his fall, turned away from the shot. */
  killed(id: number, at: { x: number; z: number }, from: { x: number; z: number } | null): void {
    const m = this.members.get(id)
    m?.loco?.died(Math.floor(Math.random() * 1000), from, at)
  }

  /** Back to the revolver (died, respawned): map weapons are lost with the life. */
  disarm(id: number): void {
    const m = this.members.get(id)
    if (m) {
      m.weapon = WEAPON_REVOLVER
      m.rounds = 0
    }
  }

  /** Register (or re-skin) a player. */
  setLook(id: number, look: PlayerLook): void {
    const have = this.members.get(id)
    if (have && have.look.key === look.key) {
      return
    }
    if (have) {
      this.dropActor(have)
    }
    this.members.set(id, {
      id,
      look,
      actor: null,
      holder: null,
      pivot: null,
      full: null,
      lod1: null,
      loco: null,
      shotAt: -9,
      acc: 0,
      wasNear: false,
      phase: Math.random() * 4,
      anim: -1,
      animSince: 0,
      lastSeen: 0,
      rank: Number.POSITIVE_INFINITY,
      speed: 0,
      gait: GAIT_IDLE,
      caster: false,
      recoil: 0,
      weapon: have?.weapon ?? WEAPON_REVOLVER,
      rounds: have?.rounds ?? 0,
      shotgun: null,
      rifle: null,
      held: null,
      bones: [],
      skin: [],
    })
    this.assets.body(look.look.base).catch(() => undefined)
    this.ensureVat(look.look.base)
  }

  remove(id: number): void {
    const m = this.members.get(id)
    if (m) {
      this.dropActor(m)
      this.members.delete(id)
    }
  }

  /** Bake (or load from IndexedDB) the VATs for these bases up front. */
  async prepare(bases: readonly BodyKey[]): Promise<void> {
    await Promise.all(bases.map((b) => this.assets.body(b)))
    await Promise.all(bases.map((b) => this.ensureVat(b)))
  }

  private ensureVat(base: BodyKey): Promise<void> {
    if (this.vats.has(base) || this.vatLoading.has(base)) {
      return Promise.resolve()
    }
    this.vatLoading.add(base)
    return this.assets
      .body(base)
      .then(() => baseVat(this.assets, base, VAT_CLIPS))
      .then((bake: VatBake) => {
        const c = new VatCrowd(bake, 40)
        this.vats.set(base, c)
        this.hatLocal.set(base, new Matrix4().fromArray(bake.hatLocal))
        this.root.add(c.mesh)
      })
      .catch((e: unknown) => console.warn('VAT bake failed', base, e))
      .finally(() => this.vatLoading.delete(base))
  }

  private dropActor(m: Member): void {
    m.actor?.dispose()
    m.holder?.removeFromParent()
    m.actor = null
    m.bones = []
    m.skin = []
    m.holder = null
    m.pivot = null
    m.loco?.dispose()
    m.loco = null
    m.full = null
    m.lod1 = null
    m.shotgun = null
    m.rifle = null
    m.held = null
  }

  private pending: Member | null = null

  /** Your own actor now; anyone else in idle time, a few ranks early, so none is cast mid-frame. */
  private maybeBuild(m: Member, self: boolean, rank: number): boolean {
    if (self) {
      this.build(m, true)
      return true
    }
    if (rank < this.near + PREBUILD_RING && this.actorCount() < this.near + MAX_ACTORS_EXTRA) {
      this.scheduleBuild(m)
      return true
    }
    return false
  }

  /** One actor build at a time, in idle time (with a deadline so it can't starve). */
  private scheduleBuild(m: Member): void {
    if (this.pending) {
      return
    }
    this.pending = m
    const run = () => {
      const target = this.pending
      this.pending = null
      if (target && !target.actor && this.members.get(target.id) === target) {
        this.build(target, false)
      }
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 250 })
    } else {
      setTimeout(run, 0)
    }
  }

  /** Build one actor (the caller rate-limits to one per frame). */
  private build(m: Member, self: boolean): void {
    const look = m.look
    if (!this.assets.bodyNow(look.look.base)) {
      return
    }
    this.builds++
    const actor = castActor(this.assets, {
      look: look.look,
      hat: look.hat,
      hatColor: look.hatColor,
      gun: this.gun,
    })
    if (actor.hat) {
      actor.hat.scale.multiplyScalar(look.hatScale)
    }
    const holder = new Group()
    holder.scale.setScalar(READ_SCALE)
    const pivot = new Group()
    pivot.position.y = 0.9
    actor.root.position.y = -0.9
    pivot.add(actor.root)
    holder.add(pivot)
    shareDepthByKind(holder)
    this.root.add(holder)
    actor.draw()
    m.shotgun = this.longGun(actor, 'shotgun')
    m.rifle = this.longGun(actor, 'rifle')
    m.actor = actor
    m.bones = []
    actor.root.traverse((o) => {
      if ((o as { isBone?: boolean }).isBone === true) {
        o.matrixAutoUpdate = false
        o.updateMatrix()
        m.bones.push(o)
      }
    })
    m.skin = actor.meshes.map(holdSkin)
    m.holder = holder
    m.pivot = pivot
    m.loco = new Locomotion(actor, this.assets.player.animations, look.look.base)
    const mesh = actor.meshes[0]
    m.full = mesh?.geometry ?? null
    if (!self) {
      this.lodHat(m, actor)
    }
    m.caster = true
    this.setCaster(m, false)
    if (!self && mesh) {
      lodGeometry(mesh.geometry, `${look.key}:lod1`, LOD1_TRIS)
        .then((g) => {
          m.lod1 = g
        })
        .catch(() => undefined)
    }
  }

  /**
   * Everyone else's hat at an LOD (your own keeps the full lathe): from the top-down camera a
   * ~3.5k-triangle hat is a few dozen pixels, and twelve of them cost more than their bodies.
   */
  private lodHat(m: Member, actor: Actor): void {
    let n = 0
    actor.hat?.traverse((o) => {
      if (!(o instanceof Mesh)) {
        return
      }
      const key = `${m.look.key}:hat${n++}`
      lodGeometry(o.geometry as BufferGeometry, key, NEAR_HAT_TRIS)
        .then((g) => {
          if (m.actor === actor) {
            o.geometry = g
          }
        })
        .catch(() => undefined)
    })
  }

  /**
   * One map weapon fitted to him (butt in his shoulder, both hands on it), hidden until he holds
   * it. One mesh sharing the template's geometry and the long guns' one material
   * (scene/gunsmith.ts): one draw each.
   */
  private longGun(actor: Actor, kind: 'shotgun' | 'rifle'): LongGun | null {
    const obj = new Group()
    if (kind === 'shotgun') {
      const gun = shotgunMesh()
      gun.scale.set(SHOTGUN_HELD_SCALE, SHOTGUN_HELD_SCALE * 1.2, SHOTGUN_HELD_SCALE * 1.2)
      obj.add(gun)
    } else {
      // the Winchester, its far level of detail past a few metres
      obj.add(rifleObject({ lod: true }))
    }
    return actor.addLong(obj)
  }

  /**
   * Put the right gun in his hand: the revolver (drawn or holstered), or a map weapon with the
   * revolver holstered. A long gun has no holster, so it stays in his hand while he's at ease.
   */
  private arm(m: Member, actor: Actor, weapon: number, holstered: boolean): void {
    let long: LongGun | null = null
    if (weapon === WEAPON_SHOTGUN) {
      long = m.shotgun
    } else if (weapon === WEAPON_RIFLE) {
      long = m.rifle
    }
    m.held = long
    if (holstered || long) {
      actor.holsterGun()
    } else {
      actor.draw()
    }
    actor.holdLong(long)
  }

  private setCaster(m: Member, on: boolean): void {
    if (m.caster === on || !m.actor) {
      return
    }
    m.caster = on
    m.actor.root.traverse((o) => {
      o.castShadow = on
    })
  }

  /** Muzzle world position for a player's shot (falls back to chest height). */
  muzzle(id: number, x: number, z: number, aim: number, out: Vector3): Vector3 {
    const m = this.members.get(id)
    if (m?.actor && m.holder?.parent && m.holder.visible) {
      m.recoil = 1
      m.actor.root.updateWorldMatrix(true, true)
      const long = m.held
      if (long) {
        return out.copy(long.a.muzzle).applyMatrix4(long.obj.matrixWorld)
      }
      return m.actor.muzzle(out)
    }
    return out.set(x + Math.cos(aim) * 0.7, 1.35, z + Math.sin(aim) * 0.7)
  }

  /** Detach a player's hat (a Dead-Eye hit); returns it in world space for the fx to throw. */
  popHat(id: number): Group | null {
    const m = this.members.get(id)
    if (!(m?.actor && m.holder?.visible)) {
      return null
    }
    const h = m.actor.popHat()
    if (h) {
      this.scene.attach(h)
    }
    return h
  }

  update(players: readonly CrowdPlayer[], cx: number, cz: number, dt: number, nowS: number): void {
    const order = this.order
    order.length = 0
    for (const p of players) {
      order.push(p)
    }
    rankX = cx
    rankZ = cz
    order.sort(byDistance)
    for (const v of this.vats.values()) {
      v.mesh.count = 0
    }
    this.hats.reset()
    this.blobs.count = 0
    VAT_TIME.value = nowS
    const s = { near: 0, far: 0, actors: 0, casters: 0, builds: this.builds }
    this.rank(order)
    // Free slots before building: the furthest actors go first, so a packed crowd keeps its
    // nearest riders cast instead of dropping and re-baking them every few frames.
    this.evict(nowS)
    const seen = this.seen
    seen.clear()
    let built = false
    for (const [rank, p] of order.entries()) {
      const m = this.members.get(p.id)
      if (!m) {
        continue
      }
      seen.add(p.id)
      this.stride(m, p, dt, nowS - m.lastSeen > 0.5)
      m.lastSeen = nowS
      if (p.anim !== m.anim) {
        m.anim = p.anim
        m.animSince = nowS
      }
      const wantNear = rank < this.near
      if (!(m.actor || built)) {
        built = this.maybeBuild(m, p.self, rank)
      }
      if (wantNear && m.actor && m.holder) {
        this.drawNear(m, p, rank, cx, cz, dt, nowS, s)
      } else {
        if (m.holder) {
          // Off the graph, not just invisible: hidden bones still cost matrix updates.
          m.holder.removeFromParent()
        }
        m.wasNear = false
        this.drawFar(m, p, nowS)
        s.far++
      }
    }
    for (const m of this.members.values()) {
      if (!seen.has(m.id) && m.holder) {
        m.holder.removeFromParent()
        m.wasNear = false
      }
    }
    for (const v of this.vats.values()) {
      v.commit()
    }
    this.hats.commit()
    this.blobs.instanceMatrix.needsUpdate = true
    for (const m of this.members.values()) {
      if (m.actor) {
        s.actors++
      }
    }
    this.stats = s
  }

  private drawNear(
    m: Member,
    p: CrowdPlayer,
    rank: number,
    cx: number,
    cz: number,
    dt: number,
    nowS: number,
    s: Crowd['stats'],
  ): void {
    const actor = m.actor
    const holder = m.holder
    const pivot = m.pivot
    if (!(actor && holder && pivot)) {
      return
    }
    s.near++
    if (!holder.parent) {
      this.root.add(holder)
    }
    // Spawn protection: a warm pulsing glow on the body (never a blink, never see-through)
    holder.visible = !(p.self && this.hideSelf)
    if (holder.scale.x !== this.readScale) {
      holder.scale.setScalar(this.readScale)
    }
    actor.glow.value = p.flags & EF_PROTECTED ? 0.6 + 0.4 * Math.sin(nowS * Math.PI * 2 * 2.2) : 0
    holder.position.set(p.x, 0, p.z)
    holder.rotation.y = facing(p.aim)
    const mesh = actor.meshes[0] as SkinnedMesh | undefined
    const geo = p.self || !m.lod1 ? m.full : m.lod1
    if (mesh && geo && mesh.geometry !== geo) {
      mesh.geometry = geo
    }
    const caster = rank < this.casters
    this.setCaster(m, caster)
    if (caster) {
      s.casters++
    } else {
      this.blob(p.x, p.z)
    }
    if (actor.hat) {
      actor.hat.visible = (p.flags & EF_HATLESS) === 0
    }
    this.animate(m, actor, p, nowS)
    m.loco?.body(holder, pivot)
    const dist = Math.hypot(p.x - cx, p.z - cz)
    const hz = p.self || dist < NEAR_FAST_M ? 30 : 15
    m.acc += dt
    if (m.acc >= 1 / hz || !m.wasNear) {
      // the bones compose themselves while the clip, stance and long-gun IK pose them (the IK
      // reads world matrices mid-solve), then freeze until the next tick
      setAuto(m.bones, true)
      actor.longKick = m.recoil
      m.loco?.pre(m.acc)
      actor.update(m.acc)
      m.acc = 0
      this.kick(m, actor)
      for (const b of m.bones) {
        b.updateMatrix()
      }
      setAuto(m.bones, false)
      for (const touch of m.skin) {
        touch()
      }
    }
    m.recoil = Math.max(0, m.recoil - dt * 8)
    m.wasNear = true
  }

  private animate(m: Member, actor: Actor, p: CrowdPlayer, nowS: number): void {
    this.arm(m, actor, p.weapon ?? m.weapon, (p.flags & EF_HOLSTERED) !== 0)
    // a long gun can't be holstered: he carries it at the ready
    const holstered = (p.flags & EF_HOLSTERED) !== 0 && !m.held
    const loco = m.loco
    if (!loco) {
      return
    }
    // the snapshots' velocity, at the eased speed (it steps at each snapshot)
    const raw = Math.hypot(p.vx, p.vz)
    const k = raw > 0.01 ? m.speed / raw : 0
    loco.set({
      anim: p.anim,
      stance: p.stance,
      vx: p.vx * k,
      vz: p.vz * k,
      aim: p.aim,
      pitch: p.pitch ?? 0,
      holstered,
      long: m.held !== null,
      shooting: nowS - m.shotAt < 1.2,
    })
  }

  /** The revolver kicks his forearm (a long gun kicks at the shoulder: `longKick`). */
  private kick(m: Member, actor: Actor): void {
    if (m.recoil > 0 && actor.forearmR && !m.held) {
      actor.forearmR.rotation.z += m.recoil * 0.5
    }
  }

  private drawFar(m: Member, p: CrowdPlayer, nowS: number): void {
    const v = this.vats.get(m.look.look.base)
    if (!v) {
      return
    }
    const speed = m.speed
    let name: Clip = 'Idle'
    if (m.gait === GAIT_RUN || p.anim === ANIM_ROLL) {
      name = 'Run'
    } else if (m.gait === GAIT_WALK) {
      name = v.clip('Walk') ? 'Walk' : 'Run'
    }
    if (p.anim === ANIM_DEAD) {
      name = 'Death'
    } else if (p.anim === ANIM_AIM || (name === 'Idle' && !(p.flags & EF_HOLSTERED))) {
      name = 'Idle_Gun_Pointing'
    }
    const clip = v.clip(name) ?? v.clip('Idle')
    if (!clip) {
      return
    }
    let phase = m.phase
    let rate = name === 'Run' || name === 'Walk' ? gaitRate(name, speed, CLIP_WALK_SPEED) : 1
    if (name === 'Death') {
      // Play once and hold the last frame: drive the frame from the death time.
      const f = Math.min(clip.frames - 1, (nowS - m.animSince) * 15)
      rate = 1
      phase = f / 15 - nowS
    }
    const i = v.mesh.count++
    v.set(i, clip, { phase, speed: rate }, m.look)
    q.setFromAxisAngle(up, facing(p.aim))
    pos.set(p.x, 0, p.z)
    m4.compose(pos, q, one.setScalar(this.readScale))
    one.set(1, 1, 1)
    v.mesh.setMatrixAt(i, m4)
    if (!(p.flags & EF_HATLESS)) {
      headAt(v.bake, clip, vatFrame(clip, phase, rate), hp, hq)
      headM.compose(hp, hq, one)
      hatM
        .multiplyMatrices(m4, headM)
        .multiply(this.hatLocal.get(m.look.look.base) ?? headM.identity())
      hatM.scale(one.set(m.look.hatScale, m.look.hatScale, m.look.hatScale))
      one.set(1, 1, 1)
      this.hats.push(m.look.hat, hatM, hatColor(m.look))
    }
    this.blob(p.x, p.z)
  }

  private blob(x: number, z: number): void {
    if (this.blobs.count >= 40) {
      return
    }
    m4.makeTranslation(x, 0.035, z)
    this.blobs.setMatrixAt(this.blobs.count++, m4)
  }

  /**
   * His drawn ground speed and gait this frame: the snapshots' speed eased (interpolated speeds
   * step at each snapshot), then idle / walk / run with hysteresis. `fresh` (just came into
   * interest) takes the speed as is.
   */
  private stride(m: Member, p: CrowdPlayer, dt: number, fresh: boolean): void {
    const raw = Math.hypot(p.vx, p.vz)
    m.speed = fresh ? raw : m.speed + (raw - m.speed) * (1 - Math.exp(-dt * SPEED_EASE))
    m.gait = nextGait(fresh ? -1 : m.gait, m.speed)
  }

  /** Each member's distance rank this frame (`order` is sorted nearest first). */
  private rank(order: readonly CrowdPlayer[]): void {
    for (const m of this.members.values()) {
      m.rank = Number.POSITIVE_INFINITY
    }
    for (const [rank, p] of order.entries()) {
      const m = this.members.get(p.id)
      if (m) {
        m.rank = rank
      }
    }
  }

  private actorCount(): number {
    let n = 0
    for (const m of this.members.values()) {
      n += m.actor ? 1 : 0
    }
    return n
  }

  /**
   * Keep at most near + 20 actors. Actors gone from interest for 90 s go first, then the furthest
   * by rank; anyone inside the prebuild ring (rank < near + 4) is never evicted, so a rider is
   * only re-cast after he really left the ring (each cast is a full dress-and-bake).
   */
  private evict(nowS: number): void {
    const cap = this.near + MAX_ACTORS_EXTRA
    const keep = this.near + PREBUILD_RING
    const withActor: Member[] = []
    for (const m of this.members.values()) {
      if (m.actor && m.rank !== 0) {
        if (m.rank === Number.POSITIVE_INFINITY && nowS - m.lastSeen > PARK_S) {
          this.dropActor(m)
        } else {
          withActor.push(m)
        }
      }
    }
    // one slot spare, so a rider entering the ring can be cast without waiting a frame
    let over = withActor.length + 1 - cap
    if (over <= 0) {
      return
    }
    withActor.sort((a, b) => b.rank - a.rank)
    for (const m of withActor) {
      if (over <= 0 || m.rank < keep) {
        break
      }
      this.dropActor(m)
      over--
    }
  }

  dispose(): void {
    for (const m of this.members.values()) {
      this.dropActor(m)
    }
    this.members.clear()
    this.root.removeFromParent()
  }
}

/** The ranking centre for `byDistance` (module state: the sort runs with no closure per frame). */
let rankX = 0
let rankZ = 0
const d2 = (p: CrowdPlayer): number => (p.self ? -1 : (p.x - rankX) ** 2 + (p.z - rankZ) ** 2)
const byDistance = (a: CrowdPlayer, b: CrowdPlayer): number => d2(a) - d2(b)

function setAuto(bones: readonly Object3D[], on: boolean): void {
  for (const b of bones) {
    b.matrixAutoUpdate = on
  }
}

/** Idle, walk or run at this ground speed, from the last gait (-1: none yet), with hysteresis. */
function nextGait(gait: number, v: number): number {
  if (gait === GAIT_IDLE && v < WALK_ON) {
    return GAIT_IDLE
  }
  if (gait !== GAIT_IDLE && v < WALK_OFF) {
    return GAIT_IDLE
  }
  if (gait < 0 && v < WALK_ON) {
    return GAIT_IDLE
  }
  if (gait === GAIT_RUN) {
    return v < RUN_OFF ? GAIT_WALK : GAIT_RUN
  }
  return v >= RUN_ON ? GAIT_RUN : GAIT_WALK
}

/** Playback rate of a gait clip at this ground speed, so the feet roughly keep to the ground. */
function gaitRate(clip: Clip, speed: number, walk: number): number {
  return clip === 'Walk'
    ? Math.max(0.6, Math.min(1.6, speed / walk))
    : Math.max(0.6, Math.min(1.3, speed / CLIP_RUN_SPEED))
}

const hatColors = new WeakMap<PlayerLook, Color>()
function hatColor(look: PlayerLook): Color {
  let c = hatColors.get(look)
  if (!c) {
    c = look.top.clone().setHex(look.hatColor)
    hatColors.set(look, c)
  }
  return c
}
