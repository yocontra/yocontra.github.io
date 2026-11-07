// biome-ignore-all lint/complexity/useMaxParams: per-frame hot paths take positional numbers to avoid allocating
// biome-ignore-all lint/style/useThisInClassMethods: private helpers kept on the class next to the state they describe
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the near/far crowd is one system (ranking, LOD swaps, actors, VAT instances, hats, blobs)
/**
 * Frontier riders share a configured skinned budget near the camera and cached outfit VATs
 * beyond it. Your body keeps full geometry; other near actors use a mesh LOD and staggered
 * animation ticks (60 Hz local, 30 Hz nearby, 20 Hz farther away). Renderer policy chooses real
 * shadow casters; every other rider gets a contact blob. Hats and finished weapons stay visible
 * on the far tier through instancing and baked attachment tracks.
 */
import {
  type BufferGeometry,
  Group,
  InstancedMesh,
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
  ANIM_ROLL,
  ANIM_SLIDE,
  EF_HATLESS,
  EF_HOLSTERED,
  EF_PROTECTED,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  STANCE_ADS,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import type { BodyKey } from '../../data/outlaws.ts'
import type { Assets } from '../../engine/assets.ts'
import type { Actor, Clip } from '../../scene/actor.ts'
import { ownPropMaterials } from '../../scene/actor-template.ts'
import { lodGeometry } from '../../scene/lod.ts'
import type { LongHold } from '../../scene/longgun.ts'
import { REVOLVER_LOD_FAR, revolverGeometry } from '../../scene/revolver.ts'
import { rifleObject } from '../../scene/rifle.ts'
import { RIFLE_ROUNDS, SHOTGUN_SHELLS } from '../sim/constants.ts'
import { contactShadowTexture } from './contact-shadow.ts'
import { copyPlayerLook } from './crowd/actor.ts'
import type { FarClip } from './crowd/aim-gait.ts'
import { CorpsePreparation, type CorpseSnapshot } from './crowd/corpse-capture.ts'
import { type CorpseRig, cloneCorpse } from './crowd/corpse-rig.ts'
import {
  geometryReferences,
  ownGeometry,
  releaseGeometry,
  retainGeometry,
} from './crowd/geometry-lease.ts'
import { GunBatch } from './crowd/gun-batch.ts'
import { VatHats } from './crowd/hats.ts'
import { isResourceReleasedError } from './crowd/resource-cache.ts'
import { silhouetteKey } from './crowd/silhouette.ts'
import { holdSkin } from './crowd/skin-hold.ts'
import { headAt, socketAt } from './crowd/tracks.ts'
import {
  baseVat,
  releaseVat,
  setVatIdleLimit,
  VAT_TIME,
  type VatBake,
  VatCrowd,
  vatFrame,
} from './crowd/vat.ts'
import { VatWeapons } from './crowd/weapons.ts'
import {
  CLIP_WALK_SPEED,
  farStance,
  GAIT_IDLE,
  GAIT_RUN,
  GAIT_WALK,
  gaitRate,
  hatColor,
  nextGait,
  setAuto,
} from './crowd-motion.ts'
import { shareDepthByKind } from './depth-kinds.ts'
import type { GestureKind } from './gestures.ts'
import { Locomotion } from './locomotion.ts'
import type { PlayerLook } from './looks.ts'
import { CORPSE_MAX_FALL, CORPSE_MAX_RISE } from './ragdoll-motion.ts'
import { shotgunMesh } from './shotgun.ts'

const VAT_CLIPS: Clip[] = [
  'Idle',
  'Walk',
  'Run',
  'Idle_Gun_Pointing',
  'Death',
  'Sprint',
  'Crouch_Idle',
  'Crouch_Walk',
]
const NEAR_FAST_M = 12
const SHADOW_CASTERS = 6
const LOD1_TRIS = 3000
/** Triangles in a skinned (near) rider's hat, other than yours. */
const NEAR_HAT_TRIS = 800
/** How fast the drawn ground speed follows the snapshots' (1/s). */
const SPEED_EASE = 10
/**
 * Built actors kept beyond the skinned cap. A parked actor (off the graph) costs nothing per frame,
 * only its geometry and bones in memory, while re-casting one is a full dress-and-bake plus a GPU
 * upload (a frame spike); so riders who drift out and back in keep theirs.
 */
/** Mid-match actor casts are spaced at least this far apart (ms): each is a long task. */
const CAST_GAP_MS = 1500
/** Players this many ranks beyond the skinned cap get their actor built ahead of time. */
const PREBUILD_RING = 4
/** Characters read 25% bigger than life from the top-down camera (visual only; collision is the sim's). */
export const READ_SCALE = 1.25
/** The riders' revolver, its length (m) before `READ_SCALE`. */
const GUN_SIZE = 0.32
/** Map weapons: how big they read (the coach gun a touch heavier than life, to read from the sky). */
const SHOTGUN_HELD_SCALE = 1.15

/** What the crowd needs to know about one player this frame. */
export interface CrowdPlayer {
  id: number
  x: number
  z: number
  /** Feet height, m (0 on the street, a porch roof's top on a catwalk). */
  y: number
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
  vatKey: string
  generation: number
  suppressed: boolean
  hatLost: boolean
  lastPlayer: CrowdPlayer | null
  lastFeetY: number | null
  verticalSpeed: number
  farPose: {
    clip: string
    time: number
    phase: number
    primarySocket?: 'hand' | 'holster'
    world: Matrix4
    weapon: number
    attachments: NonNullable<CorpseSnapshot['attachments']>
  } | null
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

const facing = (aim: number): number => Math.PI / 2 - aim

const m4 = new Matrix4()
const headM = new Matrix4()
const hatM = new Matrix4()
const weaponM = new Matrix4()
const q = new Quaternion()
const hq = new Quaternion()
const hp = new Vector3()
const headPose = { position: hp, rotation: hq }
const pos = new Vector3()
const one = new Vector3(1, 1, 1)
const up = new Vector3(0, 1, 0)
const side = new Vector3(1, 0, 0)

export class Crowd {
  readonly root = new Group()
  private readonly scene: Scene
  private readonly assets: Assets
  private readonly members = new Map<number, Member>()
  private generation = 0
  private readonly corpsePreparation: CorpsePreparation
  private readonly vats = new Map<string, VatCrowd>()
  private readonly vatLoading = new Map<string, Promise<void>>()
  private readonly vatOwners = new Map<string, PlayerLook['look']>()
  private readonly failedVats = new Set<string>()
  private readonly lifecycle = { disposed: false }
  private readonly hats: VatHats
  private readonly farWeapons: VatWeapons
  private readonly hatLocal = new Map<string, Matrix4>()
  private readonly blobs: InstancedMesh
  readonly ring: Mesh
  /** Every skinned rider's revolver as one instanced draw per part. */
  private readonly gunBatch: GunBatch
  /** Skinned cap supplied by the current renderer policy. */
  private nearBudget = 0
  get near(): number {
    return this.nearBudget
  }
  set near(value: number) {
    this.nearBudget = value
    setVatIdleLimit(value <= 2 ? 1 : 4)
  }
  /** Skinned riders casting real shadows, nearest first (the rest get a blob). */
  casters = SHADOW_CASTERS
  /**
   * How big characters read: 1.25 from the top-down camera, life size (1) at eye level, where a
   * bigger-than-life rider would tower over the doors. Set by the game's view mode.
   */
  readScale = READ_SCALE
  /** First person (or a lens pulled into your head): your own body isn't drawn. */
  hideSelf = false
  /** Your body's opacity (dithered): the shooter camera thins it out when the lens is close. */
  selfFade = 1
  private selfFaded = 1
  private readonly order: CrowdPlayer[] = []
  /** Ids drawn this frame (reused). */
  private readonly seen = new Set<number>()
  stats = { near: 0, far: 0, actors: 0, casters: 0, builds: 0 }
  /** Actors cast so far (each is a full dress-and-bake; churn here is the crowd's main CPU cost). */
  private readonly blobTexture = contactShadowTexture()
  private builds = 0
  private lastBuildMs = 0
  private maxBuildMs = 0

  livingStats() {
    let parked = 0
    for (const member of this.members.values()) {
      if (member.actor && !member.holder?.parent) {
        parked++
      }
    }
    return {
      ...this.corpsePreparation.stats,
      actors: this.actorCount(),
      parked,
      builds: this.builds,
      lastBuildMs: this.lastBuildMs,
      maxBuildMs: this.maxBuildMs,
    }
  }

  constructor(scene: Scene, assets: Assets, near: number) {
    this.scene = scene
    this.assets = assets
    this.corpsePreparation = new CorpsePreparation(assets)
    this.near = near
    this.root.name = 'crowd'
    scene.add(this.root)
    this.hats = new VatHats(this.root, 40)
    this.farWeapons = new VatWeapons(this.root, 80)
    this.blobs = new InstancedMesh(
      new PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: this.blobTexture, transparent: true, depthWrite: false }),
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
    // the Peacemaker (scene/revolver.ts) at its riders' detail, the low level past a few metres
    this.gunBatch = new GunBatch(this.root, 40, {
      geometry: revolverGeometry(GUN_SIZE, 'lo'),
      distance: REVOLVER_LOD_FAR,
    })
    // the riders' revolvers are copied into their instances once the frame's matrices are current
    const before = scene.onBeforeRender
    scene.onBeforeRender = (...args) => {
      before.apply(scene, args)
      this.gunBatch.sync(args[2])
    }
  }

  /** He took a map weapon (`EV_PICKUP_TAKEN` of a shotgun or rifle spot). */
  armed(id: number, weapon: number): void {
    const m = this.members.get(id)
    if (m) {
      // a new gun comes up from the hip
      m.loco?.gesture('draw')
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
    m.loco?.fired()
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

  /** A one-shot gesture for a rider (the throw, a pickup, the call-out, the draw, the bank). */
  gesture(id: number, kind: GestureKind): void {
    this.members.get(id)?.loco?.gesture(kind)
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

  /** Snapshot the currently visible dress/pose before the kill event changes animation state. */
  captureCorpse(id: number, at?: { x: number; y?: number; z: number }): Promise<CorpseRig | null> {
    const m = this.members.get(id)
    if (!m || m.suppressed || this.isDisposed()) {
      return Promise.resolve(null)
    }
    const generation = m.generation
    const identity = `${generation}/${m.look.key}`
    if (m.actor && m.full && m.wasNear) {
      const rig = cloneCorpse(m.actor, m.full, identity)
      rig.velocity.set(m.lastPlayer?.vx ?? 0, m.verticalSpeed, m.lastPlayer?.vz ?? 0)
      return Promise.resolve(rig)
    }
    const p = m.lastPlayer
    const world =
      m.farPose?.world.clone() ??
      new Matrix4()
        .makeRotationY(facing(p?.aim ?? 0))
        .setPosition(p?.x ?? at?.x ?? 0, p?.y ?? at?.y ?? 0, p?.z ?? at?.z ?? 0)
        .scale(new Vector3().setScalar(this.readScale))
    const snapshot: CorpseSnapshot = {
      identity,
      look: copyPlayerLook(m.look),
      world,
      clip: m.farPose?.clip ?? 'Idle_Gun_Pointing',
      time: m.farPose?.time ?? 0,
      flags: (p?.flags ?? 0) | (m.hatLost ? EF_HATLESS : 0),
      weapon: m.farPose?.weapon ?? p?.weapon ?? m.weapon,
      velocity: new Vector3(p?.vx ?? 0, m.verticalSpeed, p?.vz ?? 0),
      phase: m.farPose?.phase ?? 0,
      primarySocket:
        m.farPose?.primarySocket ?? ((p?.flags ?? 0) & EF_HOLSTERED ? 'holster' : 'hand'),
      attachments: Object.fromEntries(
        Object.entries(m.farPose?.attachments ?? {}).map(([key, matrix]) => [key, matrix.clone()]),
      ),
    }
    return this.corpsePreparation.capture(snapshot).then((rig) => {
      if (this.isDisposed() || this.members.get(id) !== m || m.generation !== generation) {
        rig.dispose()
        return null
      }
      return rig
    })
  }

  /** Only the captured life/look can hand its rendering over to physics. */
  suppressCorpse(id: number, identity: string): boolean {
    const m = this.members.get(id)
    if (!m || identity !== `${m.generation}/${m.look.key}`) {
      return false
    }
    m.suppressed = true
    m.holder?.removeFromParent()
    m.wasNear = false
    return true
  }

  /** A new life invalidates pending captures; corpse expiry never calls this. */
  releaseCorpse(id: number): void {
    const m = this.members.get(id)
    if (m) {
      m.generation = ++this.generation
      m.suppressed = false
      m.hatLost = false
      m.farPose = null
      m.lastFeetY = null
      m.verticalSpeed = 0
      m.shotAt = -9
      m.recoil = 0
      m.anim = -1
      m.acc = 0
      m.wasNear = false
      if (m.actor) {
        setAuto(m.bones, true)
        m.loco?.dispose()
        this.corpsePreparation.reset(m.look, m.actor)
        m.loco = new Locomotion(m.actor, this.assets.player.animations, m.look.look.base)
        for (const bone of m.bones) {
          bone.updateMatrix()
        }
        setAuto(m.bones, false)
        this.selfFaded = -1
        if (m.actor.hat) {
          m.actor.hat.visible = true
          m.actor.hat.traverse((node) => {
            node.castShadow = m.caster
          })
        }
        for (const touch of m.skin) {
          touch()
        }
      }
    }
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
      vatKey: silhouetteKey(look.look),
      generation: ++this.generation,
      suppressed: have?.suppressed ?? false,
      hatLost: false,
      lastPlayer: null,
      lastFeetY: null,
      verticalSpeed: 0,
      farPose: null,
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
    this.releaseUnusedVats()
    this.corpsePreparation.releaseUnused(
      new Set([...this.members.values()].map((member) => member.look.key)),
    )
    void this.corpsePreparation.retain(look).catch(() => undefined)
    void this.ensureVat(look.look)
  }

  remove(id: number): void {
    const m = this.members.get(id)
    if (m) {
      this.dropActor(m)
      this.members.delete(id)
      this.corpsePreparation.releaseUnused(
        new Set([...this.members.values()].map((member) => member.look.key)),
      )
      this.releaseUnusedVats()
    }
  }

  /** Load the base models needed by the initial roster. Outfit bakes follow in prepareLooks. */
  async prepare(bases: readonly BodyKey[]): Promise<void> {
    await Promise.all(bases.map((b) => this.assets.body(b)))
  }

  /** Finish the roster's defining garments before the loading screen leaves. */
  async prepareLooks(): Promise<void> {
    await Promise.all(
      [...this.members.values()].flatMap((m) => [
        this.ensureVat(m.look.look),
        this.corpsePreparation.retain(m.look).catch(() => undefined),
      ]),
    )
  }

  private isDisposed(): boolean {
    return this.lifecycle.disposed
  }

  private ensureVat(source: BodyKey | PlayerLook['look']): Promise<void> {
    const look = typeof source === 'string' ? { base: source, tint: {}, scale: 1 } : source
    const key = silhouetteKey(look)
    if (this.isDisposed() || this.vats.has(key)) {
      return Promise.resolve()
    }
    const pending = this.vatLoading.get(key)
    if (pending) {
      return pending
    }
    this.vatOwners.set(key, look)
    const job = baseVat(this.assets, look, VAT_CLIPS)
      .then((bake: VatBake) => {
        if (this.isDisposed() || this.vatOwners.get(key) !== look) {
          return
        }
        const c = new VatCrowd(bake, 40)
        this.vats.set(key, c)
        this.failedVats.delete(key)
        this.hatLocal.set(key, new Matrix4().fromArray(bake.hatLocal))
        this.root.add(c.mesh)
      })
      .catch(async (e: unknown) => {
        if (this.vatOwners.get(key) !== look) {
          return
        }
        this.vatOwners.delete(key)
        if (!isResourceReleasedError(e)) {
          console.warn('VAT bake failed; using skinned riders', key, e)
          this.failedVats.add(key)
          await this.fallbackActors(key)
        }
      })
      .finally(() => {
        if (this.vatLoading.get(key) === job) {
          this.vatLoading.delete(key)
        }
      })
    this.vatLoading.set(key, job)
    return job
  }

  /** Keep bodies visible if a worker/texture bake fails. Exceptional casts stay off gameplay tasks. */
  private async fallbackActors(key: string): Promise<void> {
    for (const m of this.members.values()) {
      if (m.vatKey !== key || m.actor) {
        continue
      }
      // biome-ignore lint/performance/noAwaitInLoops: one fallback cast per macrotask
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (this.isDisposed() || !this.failedVats.has(key)) {
        return
      }
      if (this.members.get(m.id) === m && !m.actor) {
        this.build(m, false)
        m.holder?.removeFromParent()
      }
    }
  }

  private releaseUnusedVats(): void {
    const needed = new Set([...this.members.values()].map((m) => m.vatKey))
    for (const key of this.failedVats) {
      if (!needed.has(key)) {
        this.failedVats.delete(key)
      }
    }
    for (const [key, look] of this.vatOwners) {
      if (!needed.has(key)) {
        this.releaseVariant(key, look)
      }
    }
  }

  private releaseVariant(key: string, look: PlayerLook['look']): void {
    const vat = this.vats.get(key)
    if (vat) {
      vat.mesh.removeFromParent()
      vat.mesh.dispose()
      vat.mesh.geometry.dispose()
      const material = vat.mesh.material
      for (const mat of Array.isArray(material) ? material : [material]) {
        mat.dispose()
      }
    }
    this.vats.delete(key)
    this.hatLocal.delete(key)
    this.vatOwners.delete(key)
    this.vatLoading.delete(key)
    releaseVat(look, VAT_CLIPS)
  }

  private dropActor(m: Member): void {
    if (m.actor) {
      const geometry = new Set([m.full, m.lod1, ...m.actor.meshes.map((mesh) => mesh.geometry)])
      for (const geo of geometry) {
        if (geo) {
          releaseGeometry(geo)
        }
      }
      const materials = new Set<import('three').Material>()
      for (const mesh of m.actor.meshes) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          materials.add(material)
        }
      }
      m.actor.root.traverse((object) => {
        if (object instanceof Mesh && object.userData.actorMaterial === true) {
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            materials.add(material)
          }
        }
      })
      m.actor.hat?.traverse((object) => {
        if (object instanceof Mesh) {
          object.geometry.dispose()
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            materials.add(material)
          }
        }
      })
      for (const material of materials) {
        material.dispose()
      }
      m.actor.dispose()
    }
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
    if (rank < this.near + PREBUILD_RING) {
      this.scheduleBuild(m)
      return true
    }
    return false
  }

  /**
   * Cast actors before the match, on the loading screen, so none lands on a gameplay frame: your
   * own first, then the nearest (`distOf`), up to `limit` actors in all. One cast per
   * macrotask, so the loading bar keeps moving. Returns how many it cast.
   */
  async precast(
    limit: number,
    self: number,
    distOf: (id: number) => number,
    onEach?: (n: number) => void,
  ): Promise<number> {
    let n = 0
    const key = (m: Member) => (m.id === self ? -1 : distOf(m.id))
    const order = [...this.members.values()].sort((a, b) => key(a) - key(b))
    for (const m of order) {
      if (this.actorCount() >= limit) {
        break
      }
      if (m.actor) {
        continue
      }
      // biome-ignore lint/performance/noAwaitInLoops: one cast per macrotask, on purpose
      await this.corpsePreparation.retain(m.look).catch(() => undefined)
      if (this.isDisposed() || this.members.get(m.id) !== m) {
        continue
      }
      this.build(m, m.id === self)
      // parked off the graph until he's drawn
      m.holder?.removeFromParent()
      n++
      onEach?.(n)
      await new Promise((r) => setTimeout(r, 0))
    }
    return n
  }

  /** Mid-match casts: not before this time (ms): at most one every `CAST_GAP_MS`. */
  private castOk = 0

  /** One actor build at a time, in idle time, spaced out (a cast is a long task). */
  private scheduleBuild(m: Member): void {
    if (this.pending || performance.now() < this.castOk) {
      return
    }
    this.castOk = performance.now() + CAST_GAP_MS
    this.pending = m
    const run = () => {
      const target = this.pending
      this.pending = null
      if (!this.isDisposed() && target && !target.actor && this.members.get(target.id) === target) {
        this.build(target, false)
      }
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 1500 })
    } else {
      setTimeout(run, 0)
    }
  }

  /** Build one actor (the caller rate-limits to one per frame). */
  private build(m: Member, self: boolean): void {
    const started = performance.now()
    const look = m.look
    if (!this.assets.bodyNow(look.look.base)) {
      return
    }
    const actor = this.corpsePreparation.fork(look)
    if (!actor) {
      void this.corpsePreparation.retain(look).catch(() => undefined)
      return
    }
    this.builds++
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
    if (actor.gun) {
      this.gunBatch.adopt(actor.gun)
    }
    if (actor.offGun) {
      this.gunBatch.adopt(actor.offGun)
    }
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
    const mesh = actor.meshes.at(0)
    m.full = mesh?.geometry ?? null
    if (!self) {
      this.lodHat(m, actor)
    }
    m.caster = true
    this.setCaster(m, false)
    if (!self && mesh) {
      lodGeometry(mesh.geometry, `${look.key}:lod1`, LOD1_TRIS)
        .then((g) => {
          if (m.actor === actor) {
            if (geometryReferences(g)) {
              retainGeometry(g)
            } else {
              ownGeometry(g)
            }
            m.lod1 = g
          } else if (!geometryReferences(g)) {
            g.dispose()
          }
        })
        .catch(() => undefined)
    }
    this.lastBuildMs = performance.now() - started
    this.maxBuildMs = Math.max(this.maxBuildMs, this.lastBuildMs)
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
            o.geometry.dispose()
            o.geometry = g
          } else {
            g.dispose()
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
    ownPropMaterials(obj)
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
    // The pair shares one firing mechanic; the spare remains visibly in its own holster.
    if (actor.offGun && actor.offHolster) {
      actor.offHolster.add(actor.offGun)
      actor.offGun.position.set(0, 0, 0)
      actor.offGun.rotation.set(0, 0, 0)
    }
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
  muzzle(id: number, x: number, z: number, aim: number, out: Vector3, feetY = 0): Vector3 {
    const m = this.members.get(id)
    if (m?.actor && m.holder?.parent && m.holder.visible) {
      m.recoil = 1
      m.loco?.fired()
      m.actor.root.updateWorldMatrix(true, true)
      const long = m.held
      if (long) {
        out.copy(long.a.muzzle).applyMatrix4(long.obj.matrixWorld)
      } else {
        m.actor.muzzle(out)
      }
      // the gun comes up with the shot (the arm layer, the shouldered long gun) a tick after this:
      // a muzzle still at the hip or the holster gets the raised one's spot instead
      const ahead = (out.x - x) * Math.cos(aim) + (out.z - z) * Math.sin(aim)
      if (out.y > feetY + 1.15 * this.readScale && ahead > 0.25) {
        return out
      }
      const reach = long ? 1.05 : 0.75
      return out.set(
        x + Math.cos(aim) * reach,
        feetY + 1.42 * this.readScale,
        z + Math.sin(aim) * reach,
      )
    }
    return out.set(x + Math.cos(aim) * 0.7, feetY + 1.35, z + Math.sin(aim) * 0.7)
  }

  /** Detach a player's hat (a Dead-Eye hit); returns it in world space for the fx to throw. */
  popHat(id: number): Group | null {
    const m = this.members.get(id)
    if (m) {
      m.hatLost = true
    }
    if (!(m?.actor && m.holder?.visible)) {
      return null
    }
    const h = m.actor.popHat()
    if (h) {
      this.scene.attach(h)
    }
    return h
  }

  /**
   * The shooter views: the skinned slots go to riders inside the view cone first (yaw: forward is
   * (cos, sin); half: the lens's horizontal half-angle). Null (top-down) ranks by distance alone.
   */
  setView(yaw: number | null, half = 0): void {
    if (yaw === null) {
      viewCos = 2
      return
    }
    viewX = Math.cos(yaw)
    viewZ = Math.sin(yaw)
    // a margin past the frame's edge, so the swap to skinned happens off screen
    viewCos = Math.cos(Math.min(Math.PI, half + VIEW_MARGIN))
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one flat per-player draw pass
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
    this.farWeapons.reset()
    this.gunBatch.reset()
    this.blobs.count = 0
    VAT_TIME.value = nowS
    const s = { near: 0, far: 0, actors: 0, casters: 0, builds: this.builds }
    this.rank(order)
    // Free slots before building: the furthest actors go first, so a packed crowd keeps its
    // nearest riders cast instead of dropping and re-baking them every few frames.
    const seen = this.seen
    seen.clear()
    let built = false
    for (const [rank, p] of order.entries()) {
      const m = this.members.get(p.id)
      if (!m) {
        continue
      }
      m.verticalSpeed =
        m.lastFeetY === null
          ? 0
          : Math.max(
              -CORPSE_MAX_FALL,
              Math.min(CORPSE_MAX_RISE, (p.y - m.lastFeetY) / Math.max(0.001, dt)),
            )
      m.lastFeetY = p.y
      m.lastPlayer = p
      if (m.suppressed) {
        m.holder?.removeFromParent()
        continue
      }
      seen.add(p.id)
      this.stride(m, p, dt, nowS - m.lastSeen > 0.5)
      m.lastSeen = nowS
      if (p.anim !== m.anim) {
        m.anim = p.anim
        m.animSince = nowS
      }
      const wantNear = rank < this.near || this.failedVats.has(m.vatKey)
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
    this.farWeapons.commit()
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
    if (p.self) {
      this.fadeSelf(actor)
    }
    if (holder.scale.x !== this.readScale) {
      holder.scale.setScalar(this.readScale)
    }
    actor.glow.value = p.flags & EF_PROTECTED ? 0.6 + 0.4 * Math.sin(nowS * Math.PI * 2 * 2.2) : 0
    holder.position.set(p.x, p.y, p.z)
    holder.rotation.y = facing(p.aim)
    const mesh = actor.meshes.at(0) as SkinnedMesh | undefined
    const geo = p.self || !m.lod1 ? m.full : m.lod1
    if (mesh && geo && mesh.geometry !== geo) {
      mesh.geometry = geo
    }
    const caster = rank < this.casters
    this.setCaster(m, caster)
    if (caster) {
      s.casters++
    } else {
      this.blob(p.x, p.y, p.z)
    }
    this.rigidParts(actor, holder, p, m.hatLost)
    this.animate(m, actor, p, nowS)
    m.loco?.body(holder, pivot)
    if (!holder.visible) {
      // your own body in first person: nothing shows it, so it doesn't animate (it picks up
      // where it is when the lens pulls back out)
      m.wasNear = false
      return
    }
    const dist = Math.hypot(p.x - cx, p.z - cz)
    // Your own rider every frame; other skinned riders at 30 Hz within 12 m and 20 Hz beyond.
    // The VAT crowd (everyone past the near slots) still animates every frame in the shader.
    let hz = dist < NEAR_FAST_M ? 30 : 20
    if (p.self) {
      hz = 60
    }
    m.acc += dt
    const first = !m.wasNear
    if (m.acc >= 1 / hz || first) {
      // the bones compose themselves while the clip, stance and long-gun IK pose them (the IK
      // reads world matrices mid-solve), then freeze until the next tick
      setAuto(m.bones, true)
      actor.longKick = m.recoil
      m.loco?.pre(m.acc)
      actor.update(m.acc)
      // stagger the riders' mixer ticks across frames (by id), so they don't all land on one
      m.acc = first ? -(m.id % 4) / 60 : 0
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

  /**
   * Your body thinned out (hashed alpha: no sorting, no blending) while the lens is close, so it
   * never fills the frame or hides the crosshair.
   */
  private fadeSelf(actor: Actor): void {
    const f = Math.round(this.selfFade * 20) / 20
    if (f === this.selfFaded) {
      return
    }
    this.selfFaded = f
    actor.root.traverse((o) => {
      const mat = (o as Partial<Mesh>).material
      if (mat && !Array.isArray(mat) && (o as Partial<Mesh>).isMesh) {
        if (!mat.alphaHash) {
          mat.alphaHash = true
          mat.needsUpdate = true
        }
        mat.opacity = f
      }
    })
  }

  /** His hat (unless it was shot off) and his revolver (into the crowd's gun batch). */
  private rigidParts(actor: Actor, holder: Object3D, p: CrowdPlayer, hatLost: boolean): void {
    if (actor.hat) {
      actor.hat.visible = (p.flags & EF_HATLESS) === 0 && !hatLost
    }
    if (holder.visible && actor.gun) {
      this.gunBatch.push(actor.gun)
    }
    if (holder.visible && actor.offGun) {
      this.gunBatch.push(actor.offGun)
    }
  }

  private animate(m: Member, actor: Actor, p: CrowdPlayer, nowS: number): void {
    // on the sights the gun is out, whatever the holster timer says (it's the sim's Dead-Eye clock)
    const drawn = (p.stance & STANCE_ADS) !== 0
    this.arm(m, actor, p.weapon ?? m.weapon, (p.flags & EF_HOLSTERED) !== 0 && !drawn)
    // a long gun can't be holstered: he carries it at the ready
    const holstered = (p.flags & EF_HOLSTERED) !== 0 && !m.held && !drawn
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
      detail: p.self || m.rank < 6,
    })
  }

  /** The revolver kicks his forearm (a long gun kicks at the shoulder: `longKick`). */
  private kick(m: Member, actor: Actor): void {
    if (m.recoil > 0 && actor.forearmR && !m.held) {
      actor.forearmR.rotation.z += m.recoil * 0.5
    }
  }

  private drawFar(m: Member, p: CrowdPlayer, nowS: number): void {
    const key = m.vatKey
    const v = this.vats.get(key)
    if (!v) {
      return
    }
    const speed = m.speed
    let name: FarClip = 'Idle'
    if (m.gait === GAIT_RUN || p.anim === ANIM_ROLL) {
      name = 'Run'
    } else if (m.gait === GAIT_WALK) {
      name = v.clip('Walk') ? 'Walk' : 'Run'
    }
    name = farStance(p, name, (c) => v.clip(c) !== null)
    const clip = v.clip(name) ?? v.clip('Idle')
    if (!clip) {
      return
    }
    let phase = m.phase
    const walking = name === 'Walk' || name === 'Walk_Aim'
    const running = name === 'Run' || name === 'Run_Aim'
    let rate = walking || running ? gaitRate(walking ? 'Walk' : 'Run', speed, CLIP_WALK_SPEED) : 1
    if (name === 'Sprint' || name === 'Crouch_Walk') {
      rate = Math.max(0.6, Math.min(1.6, speed / (name === 'Sprint' ? 7.2 : 1.6)))
    }
    if (name === 'Death') {
      // Play once and hold the last frame: drive the frame from the death time.
      const f = Math.min(clip.frames - 1, (nowS - m.animSince) * 15)
      rate = 1
      phase = f / 15 - nowS
    }
    const i = v.mesh.count++
    v.set(i, clip, { phase, speed: rate }, m.look)
    q.setFromAxisAngle(up, facing(p.aim))
    pos.set(p.x, p.y, p.z)
    if (p.anim === ANIM_SLIDE) {
      // the crouch, leaning back feet first
      q.multiply(hq.setFromAxisAngle(side, -0.7))
      pos.y -= 0.2
    }
    m4.compose(pos, q, one.setScalar(this.readScale))
    one.set(1, 1, 1)
    v.mesh.setMatrixAt(i, m4)
    const pose = m.farPose ?? {
      clip: name,
      time: 0,
      phase: 0,
      world: new Matrix4(),
      weapon: WEAPON_REVOLVER,
      attachments: {},
    }
    pose.clip = name
    pose.time = vatFrame(clip, phase, rate) / 15
    pose.phase = vatFrame(clip, phase, rate) / clip.frames
    pose.world.copy(m4)
    pose.weapon = p.weapon ?? m.weapon
    m.farPose = pose
    if (!(p.flags & EF_HATLESS || m.hatLost)) {
      headAt(v.bake, clip, vatFrame(clip, phase, rate), headPose)
      headM.compose(hp, hq, one)
      hatM.multiplyMatrices(m4, headM).multiply(this.hatLocal.get(key) ?? headM.identity())
      hatM.scale(one.set(m.look.hatScale, m.look.hatScale, m.look.hatScale))
      one.set(1, 1, 1)
      this.recordFarSocket(m, 'hat', hatM)
      this.hats.push(m.look.hat, hatM, hatColor(m.look), m.look.hatDetail)
    }
    this.drawFarWeapons(m, p, v, clip, vatFrame(clip, phase, rate))
    this.blob(p.x, p.y, p.z)
  }

  private drawFarWeapons(
    m: Member,
    p: CrowdPlayer,
    v: VatCrowd,
    clip: VatBake['clips'][number],
    frame: number,
  ): void {
    const weapon = p.weapon ?? m.weapon
    const holstered =
      weapon !== WEAPON_REVOLVER ||
      ((p.flags & EF_HOLSTERED) !== 0 && (p.stance & STANCE_ADS) === 0)
    const socket = holstered ? 'holster' : 'hand'
    if (m.farPose) {
      m.farPose.primarySocket = socket
    }
    if (socketAt(v.bake.sockets[socket], clip, frame, weaponM)) {
      weaponM.premultiply(m4)
      this.recordFarSocket(m, 'primary', weaponM)
      this.farWeapons.push(WEAPON_REVOLVER, weaponM, m.look.gun)
    }
    if (m.look.look.offGun && socketAt(v.bake.sockets.offHolster, clip, frame, weaponM)) {
      weaponM.premultiply(m4)
      this.recordFarSocket(m, 'offhand', weaponM)
      this.farWeapons.push(WEAPON_REVOLVER, weaponM, m.look.gun)
    }
    if (
      (weapon === WEAPON_RIFLE || weapon === WEAPON_SHOTGUN) &&
      socketAt(v.bake.sockets[weapon === WEAPON_RIFLE ? 'rifle' : 'shotgun'], clip, frame, weaponM)
    ) {
      weaponM.premultiply(m4)
      this.recordFarSocket(m, 'long', weaponM)
      this.farWeapons.push(weapon, weaponM)
    }
  }

  private recordFarSocket(
    m: Member,
    key: 'primary' | 'offhand' | 'long' | 'hat',
    matrix: Matrix4,
  ): void {
    const pose = m.farPose
    if (pose) {
      const socket = pose.attachments[key] ?? new Matrix4()
      socket.copy(matrix)
      pose.attachments[key] = socket
    }
  }

  private blob(x: number, y: number, z: number): void {
    if (this.blobs.count >= 40) {
      return
    }
    m4.makeTranslation(x, y + 0.035, z)
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

  dispose(): void {
    this.lifecycle.disposed = true
    this.corpsePreparation.releaseUnused(new Set())
    for (const [key, look] of this.vatOwners) {
      this.releaseVariant(key, look)
    }
    for (const m of this.members.values()) {
      this.dropActor(m)
    }
    this.members.clear()
    this.failedVats.clear()
    this.hats.dispose()
    this.root.traverse((object) => {
      if (object instanceof InstancedMesh) {
        object.dispose()
      }
    })
    this.blobTexture.dispose()
    this.blobs.geometry.dispose()
    for (const mat of Array.isArray(this.blobs.material)
      ? this.blobs.material
      : [this.blobs.material]) {
      mat.dispose()
    }
    this.ring.geometry.dispose()
    for (const mat of Array.isArray(this.ring.material)
      ? this.ring.material
      : [this.ring.material]) {
      mat.dispose()
    }
    this.root.removeFromParent()
  }
}

/** How far past the frame's edge (rad) a rider still counts as in view. */
const VIEW_MARGIN = 0.4
/** The ranking centre for `byDistance` (module state: the sort runs with no closure per frame). */
let rankX = 0
let rankZ = 0
/** The look direction and the cone (cos of half its angle) the skinned slots favour; off = 2. */
let viewX = 1
let viewZ = 0
let viewCos = 2
/** Past this (m², 4 m) a rider out of view ranks as if this much further (m²): 30 m. */
const BEHIND_FROM2 = 16
const BEHIND_ADD2 = 900
const d2 = (p: CrowdPlayer): number => {
  if (p.self) {
    return -1
  }
  const dx = p.x - rankX
  const dz = p.z - rankZ
  const r2 = dx * dx + dz * dz
  // riders out of view (behind you, off to the side) give their skinned slot to riders in view
  if (r2 > BEHIND_FROM2 && (dx * viewX + dz * viewZ) / Math.sqrt(r2) < viewCos) {
    return r2 + BEHIND_ADD2
  }
  return r2
}
const byDistance = (a: CrowdPlayer, b: CrowdPlayer): number => d2(a) - d2(b)
