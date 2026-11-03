// biome-ignore-all lint/complexity/useMaxParams: per-frame hot paths take positional numbers to avoid allocating
// biome-ignore-all lint/style/useThisInClassMethods: private helpers kept on the class next to the state they describe
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the near/far crowd is one system (ranking, LOD swaps, actors, VAT instances, hats, blobs)
/**
 * Everyone in the Frontier, drawn within the A15 budget (spec §9.3, stream H's measured design):
 *
 * - The nearest `near` players (12 on the floor tier, 16 above; your own player always) are
 *   GPU-skinned Actors. Yours stays at LOD0; the rest swap to a meshopt LOD1 (`scene/lod.ts`).
 *   Animation runs at 30 Hz within 12 m and 15 Hz beyond. Only the nearest 6 cast real shadows.
 * - Everyone else is a VAT instance of their base body (≤7 bases, one draw each), tinted per
 *   instance with their palette, with hats as one instanced draw per hat type on the baked head
 *   track, and one draw of blob shadows for everyone who isn't casting.
 *
 * Actors are built lazily (at most one per frame) and kept for players who stay around; until a
 * player's actor exists they're drawn as a VAT instance, so nobody ever pops out.
 */
import {
  type AnimationAction,
  AnimationClip,
  type BufferGeometry,
  CanvasTexture,
  type Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  type Scene,
  type SkinnedMesh,
  Vector3,
} from 'three'
import {
  ANIM_AIM,
  ANIM_CHANNEL,
  ANIM_DEAD,
  ANIM_DUEL,
  ANIM_RELOAD,
  ANIM_ROLL,
  ANIM_RUN,
  EF_HATLESS,
  EF_HOLSTERED,
  EF_PROTECTED,
} from '../../contract/town.ts'
import type { BodyKey } from '../../data/outlaws.ts'
import type { Assets } from '../../engine/assets.ts'
import type { Actor, Clip } from '../../scene/actor.ts'
import { castActor } from '../../scene/cast.ts'
import { lodGeometry } from '../../scene/lod.ts'
import { propDef, propObject } from '../../scene/props.ts'
import {
  baseVat,
  headAt,
  VAT_TIME,
  type VatBake,
  VatCrowd,
  VatHats,
  vatFrame,
} from './crowd/vat.ts'
import type { PlayerLook } from './looks.ts'

const VAT_CLIPS: Clip[] = ['Idle', 'Run', 'Idle_Gun_Pointing', 'Death']
const NEAR_FAST_M = 12
const SHADOW_CASTERS = 6
const LOD1_TRIS = 3000
/** Running speed the Run clip was authored for (m/s). */
const CLIP_RUN_SPEED = 5.2
const ROLL_S = 0.35
const MAX_ACTORS_EXTRA = 6
/** Characters read 25% bigger than life from the top-down camera (visual only; collision is the sim's). */
export const READ_SCALE = 1.25
const ARM_BONES = /^(?<bone>Shoulder|UpperArm|LowerArm|Index|Middle|Ring|Pinky|Thumb)\d?R$/u

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
  flags: number
  self: boolean
}

interface Member {
  id: number
  look: PlayerLook
  actor: Actor | null
  holder: Group | null
  pivot: Group | null
  full: BufferGeometry | null
  lod1: BufferGeometry | null
  arm: AnimationAction | null
  acc: number
  wasNear: boolean
  phase: number
  anim: number
  animSince: number
  lastSeen: number
  caster: boolean
  recoil: number
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
  /** Skinned cap (12 floor, 16 medium/high). */
  near: number
  private readonly order: CrowdPlayer[] = []
  stats = { near: 0, far: 0, actors: 0, casters: 0 }

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
    this.gun = def ? propObject(def) : null
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
      arm: null,
      acc: 0,
      wasNear: false,
      phase: Math.random() * 4,
      anim: -1,
      animSince: 0,
      lastSeen: 0,
      caster: false,
      recoil: 0,
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
    m.holder = null
    m.pivot = null
    m.arm = null
    m.full = null
    m.lod1 = null
  }

  /** Build one actor (the caller rate-limits to one per frame). */
  private build(m: Member, self: boolean): void {
    const look = m.look
    if (!this.assets.bodyNow(look.look.base)) {
      return
    }
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
    this.root.add(holder)
    actor.draw()
    actor.play('Idle_Gun', 0)
    m.actor = actor
    m.holder = holder
    m.pivot = pivot
    m.arm = this.armLayer(actor)
    const mesh = actor.meshes[0]
    m.full = mesh?.geometry ?? null
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

  /** The gun arm of Idle_Gun_Pointing as its own action, layered over Run while armed. */
  private armLayer(actor: Actor): AnimationAction | null {
    const src = this.assets.player.animations.find((c) => c.name.endsWith('Idle_Gun_Pointing'))
    if (!src) {
      return null
    }
    const tracks = src.tracks.filter((t) => ARM_BONES.test(t.name.split('.')[0] ?? ''))
    const clip = new AnimationClip('ArmAim', src.duration, tracks)
    const a = actor.mixer.clipAction(clip)
    a.setEffectiveWeight(0)
    a.play()
    return a
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
    if (m?.actor && m.holder?.visible) {
      m.recoil = 1
      m.actor.root.updateWorldMatrix(true, true)
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
    order.push(...players)
    const d2 = (p: CrowdPlayer) => (p.self ? -1 : (p.x - cx) ** 2 + (p.z - cz) ** 2)
    order.sort((a, b) => d2(a) - d2(b))
    for (const v of this.vats.values()) {
      v.mesh.count = 0
    }
    this.hats.reset()
    this.blobs.count = 0
    VAT_TIME.value = nowS
    const s = { near: 0, far: 0, actors: 0, casters: 0 }
    const seen = new Set<number>()
    let built = false
    for (const [rank, p] of order.entries()) {
      const m = this.members.get(p.id)
      if (!m) {
        continue
      }
      seen.add(p.id)
      m.lastSeen = nowS
      if (p.anim !== m.anim) {
        m.anim = p.anim
        m.animSince = nowS
      }
      const wantNear = rank < this.near
      if (wantNear && !m.actor && !built) {
        this.build(m, p.self)
        built = true
      }
      if (wantNear && m.actor && m.holder) {
        this.drawNear(m, p, rank, cx, cz, dt, nowS, s)
      } else {
        if (m.holder) {
          m.holder.visible = false
        }
        m.wasNear = false
        this.drawFar(m, p, nowS)
        s.far++
      }
    }
    for (const m of this.members.values()) {
      if (!seen.has(m.id) && m.holder) {
        m.holder.visible = false
        m.wasNear = false
      }
    }
    this.evict(nowS)
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
    holder.visible = !(p.flags & EF_PROTECTED) || Math.floor(nowS * 11) % 3 !== 0
    holder.position.set(p.x, 0, p.z)
    holder.rotation.y = facing(p.aim)
    const mesh = actor.meshes[0] as SkinnedMesh | undefined
    const geo = p.self || !m.lod1 ? m.full : m.lod1
    if (mesh && geo && mesh.geometry !== geo) {
      mesh.geometry = geo
    }
    const caster = rank < SHADOW_CASTERS
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
    // Roll: a quick tumble around the hips.
    if (p.anim === ANIM_ROLL) {
      const t = Math.min(1, (nowS - m.animSince) / ROLL_S)
      pivot.rotation.x = t * Math.PI * 2
    } else {
      pivot.rotation.x *= 0.5
    }
    const dist = Math.hypot(p.x - cx, p.z - cz)
    const hz = p.self || dist < NEAR_FAST_M ? 30 : 15
    m.acc += dt
    if (m.acc >= 1 / hz || !m.wasNear) {
      actor.update(m.acc)
      m.acc = 0
      if (m.recoil > 0 && actor.forearmR) {
        actor.forearmR.rotation.z += m.recoil * 0.5
      }
    }
    m.recoil = Math.max(0, m.recoil - dt * 8)
    m.wasNear = true
  }

  private animate(m: Member, actor: Actor, p: CrowdPlayer, nowS: number): void {
    const holstered = (p.flags & EF_HOLSTERED) !== 0
    if (holstered) {
      actor.holsterGun()
    } else {
      actor.draw()
    }
    const speed = Math.hypot(p.vx, p.vz)
    let clip: Clip = holstered ? 'Idle' : 'Idle_Gun'
    let once = false
    let armW = 0
    switch (p.anim) {
      case ANIM_DEAD:
        clip = 'Death'
        once = true
        break
      case ANIM_RUN:
      case ANIM_ROLL:
        clip = speed > 0.3 || p.anim === ANIM_ROLL ? 'Run' : clip
        armW = holstered ? 0 : 6
        break
      case ANIM_AIM:
        clip = 'Idle_Gun_Pointing'
        break
      case ANIM_RELOAD:
        clip = 'Idle_Gun'
        break
      case ANIM_CHANNEL:
        clip = 'Idle_Neutral'
        break
      case ANIM_DUEL:
        clip = 'Idle'
        break
      default:
        armW = holstered || speed < 0.3 ? 0 : 6
        clip = speed > 0.3 ? 'Run' : clip
        break
    }
    const a = actor.play(
      clip,
      m.wasNear ? 0.15 : 0,
      once && m.anim === ANIM_DEAD && nowS - m.animSince < 0.05,
    )
    if (clip === 'Run' && a) {
      // Backpedal when running away from the aim; match the stride to the speed.
      const dot = speed > 0.01 ? (p.vx * Math.cos(p.aim) + p.vz * Math.sin(p.aim)) / speed : 1
      a.timeScale = (dot < -0.3 ? -1 : 1) * Math.max(0.6, Math.min(1.3, speed / CLIP_RUN_SPEED))
    }
    if (m.arm) {
      m.arm.setEffectiveWeight(clip === 'Run' ? armW : 0)
    }
  }

  private drawFar(m: Member, p: CrowdPlayer, nowS: number): void {
    const v = this.vats.get(m.look.look.base)
    if (!v) {
      return
    }
    const speed = Math.hypot(p.vx, p.vz)
    let name: Clip = speed > 0.3 ? 'Run' : 'Idle'
    if (p.anim === ANIM_DEAD) {
      name = 'Death'
    } else if (p.anim === ANIM_AIM || (speed <= 0.3 && !(p.flags & EF_HOLSTERED))) {
      name = 'Idle_Gun_Pointing'
    }
    const clip = v.clip(name) ?? v.clip('Idle')
    if (!clip) {
      return
    }
    let phase = m.phase
    let rate = name === 'Run' ? Math.max(0.6, speed / CLIP_RUN_SPEED) : 1
    if (name === 'Death') {
      // Play once and hold the last frame: drive the frame from the death time.
      const f = Math.min(clip.frames - 1, (nowS - m.animSince) * 15)
      rate = 1
      phase = f / 15 - nowS
    }
    const i = v.mesh.count++
    v.set(i, clip, phase, rate, m.look.top, m.look.bottom)
    q.setFromAxisAngle(up, facing(p.aim))
    pos.set(p.x, 0, p.z)
    m4.compose(pos, q, one.setScalar(READ_SCALE))
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

  /** Free actors of players far away or gone for a while, keeping at most near + 6. */
  private evict(nowS: number): void {
    const withActor = [...this.members.values()].filter((m) => m.actor)
    const cap = this.near + MAX_ACTORS_EXTRA
    if (withActor.length <= cap) {
      return
    }
    withActor.sort((a, b) => Number(a.wasNear) - Number(b.wasNear) || a.lastSeen - b.lastSeen)
    for (const m of withActor.slice(0, withActor.length - cap)) {
      if (!m.wasNear || nowS - m.lastSeen > 5) {
        this.dropActor(m)
      }
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

const hatColors = new WeakMap<PlayerLook, Color>()
function hatColor(look: PlayerLook): Color {
  let c = hatColors.get(look)
  if (!c) {
    c = look.top.clone().setHex(look.hatColor)
    hatColors.set(look, c)
  }
  return c
}
