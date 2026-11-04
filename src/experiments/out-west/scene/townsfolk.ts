// biome-ignore-all lint/style/noExcessiveClassesPerFile: one person and the crowd of them
/**
 * The townsfolk: a handful of people on the porches, balconies and in the saloon doorway who
 * watch the duel. Each is a real character (the outlaws' rig, a per-name identity, muted period
 * clothes) at a cheap LOD, with no shadow, idling with a procedural pose: whittling on a bench,
 * shoulder on a post, forearms on a balcony rail. At the call they flinch, cower or duck; after
 * the shot some run indoors; between duels everyone is back where they were.
 *
 * They stand only on the boardwalks (|x| > 9), never in the street, so they never cross the
 * sightline or read as the opponent: muted clothes, in porch shade, at the edges of the frame.
 */
import { type Group, MathUtils, type Object3D, type SkinnedMesh, Vector3 } from 'three'
import type { BodyKey, HatKey, Look } from '../data/outlaws.ts'
import type { Assets } from '../engine/assets.ts'
import type { Actor } from './actor.ts'
import { castActor } from './cast.ts'
import { FolkPose, type PoseMix, restMix } from './folk-pose.ts'
import { identityFor } from './identity.ts'
import { lodGeometry } from './lod.ts'
import { SkinThrottle } from './skin-throttle.ts'
import { DECK, STREET } from './street.ts'

type Habit = 'whittle' | 'sit' | 'lean' | 'rail' | 'door' | 'stand'
type Reaction = 'flinch' | 'cower' | 'duck'
type Mode = 'idle' | 'react' | 'flee' | 'gone'

interface Spot {
  name: string
  base: BodyKey
  /** Where he stands or sits (feet, or the bench seat under him), and the way he faces. */
  x: number
  y: number
  z: number
  yaw: number
  habit: Habit
  /** Where he goes indoors (a door on his porch), or null: he stays and ducks. */
  door: readonly [number, number] | null
}

/** Faces the street from the right (+x) or left (-x) boardwalk. */
const FACE_R = -Math.PI / 2
const FACE_L = Math.PI / 2
/** A bench seat's height above the deck (the kit bench). */
const SEAT = 0.42
/** The porch roof's top, where the balcony folk stand. */
const ROOF = 3.16
const H = STREET.half

/**
 * In tier order (the floor tier takes the first four, medium seven, high all nine): those in the
 * standoff's frame first, up the street beyond the outlaw.
 */
const SPOTS: readonly Spot[] = [
  {
    name: 'Clara Bell',
    base: 'woman',
    x: 9.75,
    y: ROOF,
    z: 14,
    yaw: FACE_R,
    habit: 'rail',
    door: null,
  },
  {
    name: 'Walt Greer',
    base: 'worker',
    x: 9.43,
    y: DECK,
    z: 19.85,
    yaw: FACE_R - 0.35,
    habit: 'lean',
    door: [H + 2.05, 15],
  },
  {
    name: 'Ned Calloway',
    base: 'rugged',
    x: -10.4,
    y: DECK,
    z: 27.5,
    yaw: FACE_L - 0.3,
    habit: 'stand',
    door: [-(H + 2.05), 30],
  },
  {
    name: 'Ezra Dunn',
    base: 'rugged',
    x: -9.75,
    y: ROOF,
    z: 19.6,
    yaw: FACE_L,
    habit: 'rail',
    door: null,
  },
  {
    name: 'Amos Whitlock',
    base: 'worker',
    x: 10.72,
    y: DECK + SEAT,
    z: 11.3,
    yaw: FACE_R,
    habit: 'whittle',
    door: [H + 2.05, 15],
  },
  {
    name: 'Silas Moon',
    base: 'suit',
    x: 10.85,
    y: DECK,
    z: 3.05,
    yaw: FACE_R - 0.4,
    habit: 'door',
    door: [H + 2.1, 2],
  },
  {
    name: 'Hattie Crane',
    base: 'woman',
    x: -10.72,
    y: DECK + SEAT,
    z: 14.3,
    yaw: FACE_L,
    habit: 'sit',
    door: [-(H + 2.05), 18],
  },
  {
    name: 'Jed Pruitt',
    base: 'casual',
    x: -9.43,
    y: DECK,
    z: 7.55,
    yaw: FACE_L + 0.35,
    habit: 'lean',
    door: [-(H + 2.05), 5.5],
  },
  {
    name: 'Old Tom Bixby',
    base: 'casual',
    x: -10.72,
    y: DECK + SEAT,
    z: -2.8,
    yaw: FACE_L,
    habit: 'sit',
    door: null,
  },
]

/** Muted period cloth: dun, faded blue, grey, rust, sage, oatmeal. */
const SHIRTS = [0x8a_7e_6a, 0x5e_66_6e, 0x7a_72_68, 0x7e_5a_46, 0x6a_70_5a, 0xa8_9c_86, 0x6e_5e_52]
const DRESSES = [0x5e_54_50, 0x6a_5e_48, 0x50_58_5e, 0x7a_62_52]
const HATS: readonly HatKey[] = ['bowler', 'flat', 'cowboy', 'tall', 'flat', 'bowler']
const HAT_COLORS = [0x3a_32_2a, 0x5a_4e_40, 0x2a_26_22, 0x6a_5a_48]

/** Triangles a townsman draws at (his full rig is ~15k). */
const FOLK_TRIS = 4200
const HAT_TRIS = 900
/** Run speed indoors, m/s, and the Run clip's authored speed. */
const RUN_SPEED = 3.4
const CLIP_RUN = 5.2

const pick = <T>(list: readonly T[], r: number, fallback: T): T =>
  list[Math.floor(r * list.length) % list.length] ?? fallback

function lookFor(
  spot: Spot,
  assets: Assets,
  i: number,
): { look: Look; hat: HatKey; hatColor: number } {
  const id = identityFor(spot.name, assets, spot.base)
  const woman = spot.base === 'woman'
  const r = (k: number) => ((i * 7 + k * 13) % 17) / 17
  const top = woman ? pick(DRESSES, r(1), 0x5a_4a_5a) : pick(SHIRTS, r(1), 0x8a_7e_6a)
  const whiskers = woman
    ? {}
    : {
        moustache: id.moustache,
        moustacheStyle: id.moustache === undefined ? undefined : id.moustacheStyle,
        beard: id.beard,
        beardStyle: id.beard === undefined ? undefined : id.beardStyle,
        vest: r(3) > 0.6 ? pick(HAT_COLORS, r(4), 0x3a_32_2a) : undefined,
        hair: id.hair,
        stubble: id.stubble,
      }
  const loose = {
    base: spot.base,
    tint: { ...id.tint, Shirt: top, Sleeves: top },
    scale: woman ? 0.97 : 0.97 + r(2) * 0.06,
    skin: id.skin,
    build: id.build,
    face: id.face,
    stance: id.stance,
    ...whiskers,
  }
  // exact optional properties: an absent trait is left out, never set to undefined
  const look = Object.fromEntries(
    Object.entries(loose).filter(([, v]) => v !== undefined),
  ) as unknown as Look
  return { look, hat: pick(HATS, r(5), 'bowler'), hatColor: pick(HAT_COLORS, r(6), 0x3a_32_2a) }
}

/** What he settles into when nothing is happening. */
function habitMix(h: Habit): PoseMix {
  const m = restMix()
  if (h === 'whittle' || h === 'sit') {
    m.sit = 1
    m.whittle = h === 'whittle' ? 1 : 0
    m.bend = h === 'sit' ? 0.12 : 0.2
  } else if (h === 'lean') {
    m.lean = 0.14
  } else if (h === 'rail') {
    m.rail = 1
    m.bend = 0.3
  } else if (h === 'door') {
    m.lean = -0.1
  }
  return m
}

/** One person on a porch. */
class Folk {
  readonly actor: Actor
  readonly spot: Spot
  private readonly pose: FolkPose
  private readonly mix = restMix()
  private readonly want = restMix()
  private mode: Mode = 'idle'
  private reaction: Reaction = 'flinch'
  private t = Math.random() * 20
  private reactIn = 0
  private reactT = 0
  /** He'll head indoors after this shot. */
  private fleer: boolean = false as boolean
  private fleeIn = 0
  private path: Vector3[] = []
  private yaw: number
  /** What he's watching (world), and until when it holds his eye over the duel. */
  private readonly glance = new Vector3()
  private glanceT = 0
  /** His hips' height standing (m above his feet). */
  private readonly hipsH: number
  private readonly skin: SkinThrottle

  constructor(actor: Actor, spot: Spot) {
    this.actor = actor
    this.spot = spot
    this.yaw = spot.yaw
    this.pose = new FolkPose(actor.model)
    actor.play(Math.random() < 0.5 ? 'Idle' : 'Idle_Neutral', 0, false, 0.8 + Math.random() * 0.3)
    actor.update(0)
    actor.root.updateMatrixWorld(true)
    const hp = actor.hips?.getWorldPosition(new Vector3())
    this.hipsH = hp ? hp.y - actor.root.position.y : 0.95
    this.skin = new SkinThrottle(actor.root)
    // culled on a generous bound of his pose (sitting, cowering and running stay inside it):
    // off screen he costs no draw and no skinning
    actor.root.traverse((o) => {
      const m = o as Partial<SkinnedMesh>
      if (m.isSkinnedMesh === true && m.computeBoundingSphere) {
        m.computeBoundingSphere()
        if (m.boundingSphere) {
          m.boundingSphere.radius *= 1.5
          o.frustumCulled = true
        }
      }
    })
    this.home()
  }

  /** Back in his spot, at his habit (between duels). */
  home(): void {
    const s = this.spot
    this.mode = 'idle'
    this.yaw = s.yaw
    this.actor.root.visible = true
    this.actor.root.position.set(s.x, s.y, s.z)
    Object.assign(this.mix, habitMix(s.habit))
    if (s.habit === 'sit' || s.habit === 'whittle') {
      this.actor.play('Idle_Neutral', 0.2)
    }
    this.skin.touch()
  }

  /** Out of sight (indoors) until the next `home`. */
  away(): void {
    this.mode = 'gone'
    this.actor.root.visible = false
  }

  /** The call rang: react after a human beat. */
  call(): void {
    if (this.mode !== 'idle') {
      return
    }
    this.mode = 'react'
    this.reactIn = 0.08 + Math.random() * 0.28
    this.reactT = 0
    const sitting = this.spot.habit === 'sit' || this.spot.habit === 'whittle'
    const roll = Math.random()
    if (sitting) {
      this.reaction = roll < 0.6 ? 'cower' : 'flinch'
    } else {
      const kinds: Reaction[] = ['flinch', 'cower', 'duck']
      this.reaction = kinds[Math.min(2, Math.floor(roll * 2.9))] ?? 'flinch'
    }
  }

  /** The shot went off: some head indoors (`chance`), the rest stay down a while. */
  shot(chance: number): void {
    if (this.mode === 'idle') {
      this.call()
    }
    this.fleer = this.spot.door !== null && Math.random() < chance
    this.fleeIn = 0.5 + Math.random() * 0.9
  }

  /** Something caught his eye (a fake-out): look at it for a moment. */
  glanceAt(p: Vector3, near: number): void {
    const d = this.actor.root.position.distanceTo(p)
    if (this.mode === 'idle' && d < near) {
      this.glance.copy(p)
      this.glanceT = 1.2 + Math.random() * 0.8
    }
  }

  /** Seconds since the pose axes were re-read. */
  private axesAge = 99

  update(dt: number, focus: Vector3, tense: boolean): void {
    if (this.mode === 'gone') {
      return
    }
    this.t += dt
    this.axesAge += dt
    this.pose.undo()
    if (this.mode === 'flee') {
      this.run(dt)
    } else {
      this.settle(dt, focus, tense)
    }
    const a = this.actor
    a.update(dt)
    a.root.rotation.y = this.yaw
    const fast = this.mode !== 'idle' && this.reactT < 1
    const refresh = fast || this.axesAge > 0.4
    if (refresh) {
      this.axesAge = 0
    }
    const drop = this.pose.apply(this.mix, this.yaw, this.t, refresh)
    a.root.position.y = this.spot.y - drop - (this.mix.sit > 0.01 ? this.sitDrop() : 0)
    this.skin.touch()
  }

  /** How far the root sits below his seat: hips onto the bench. */
  private sitDrop(): number {
    return this.mix.sit * (this.hipsH - 0.1)
  }

  private settle(dt: number, focus: Vector3, tense: boolean): void {
    const want = this.want
    Object.assign(want, habitMix(this.spot.habit))
    if (this.mode === 'react') {
      this.reactIn -= dt
      if (this.reactIn <= 0) {
        this.reactT += dt
        this.react(want)
      }
      if (this.fleer && this.reactT > this.fleeIn) {
        this.startFlee()
        return
      }
    }
    // the head follows the duel (or a fake-out); idle eyes wander when nothing's on
    const p = this.actor.root.position
    this.glanceT -= dt
    const target = this.glanceT > 0 ? this.glance : focus
    const dx = target.x - p.x
    const dz = target.z - p.z
    let rel = Math.atan2(dx, dz) - this.yaw
    rel = Math.atan2(Math.sin(rel), Math.cos(rel))
    const wander = tense ? 0 : Math.sin(this.t * 0.31) * 0.5 + Math.sin(this.t * 0.83) * 0.2
    want.look = MathUtils.clamp(rel + wander, -1.1, 1.1)
    want.nod = MathUtils.clamp(want.nod + (p.y + 1.5 - target.y) / 20, -0.3, 0.5)
    const fast = this.mode === 'react' && this.reactT < 0.4 ? 14 : 3
    for (const k of Object.keys(this.mix) as (keyof PoseMix)[]) {
      this.mix[k] += (want[k] - this.mix[k]) * (1 - Math.exp(-fast * dt))
    }
  }

  private react(want: PoseMix): void {
    const r = this.reaction
    const settle = Math.min(1, Math.max(0, (this.reactT - 1.4) / 1.6))
    if (r === 'flinch') {
      // a jolt, then watching again, a little hunched
      const jolt = Math.max(0, 1 - this.reactT * 2.5)
      want.crouch += 0.35 * jolt + 0.08
      want.bend += 0.25 * jolt + 0.05
      want.cover += 0.25 * jolt
    } else if (r === 'cower') {
      want.crouch += 0.45 * (1 - settle * 0.6)
      want.bend += 0.55 * (1 - settle * 0.5)
      want.cover = 1 - settle * 0.6
      want.rail = 0
      want.whittle = 0
    } else {
      want.crouch += 1.15 * (1 - settle * 0.5)
      want.bend += 0.45
      want.cover = 0.6
      want.rail = 0
    }
  }

  private startFlee(): void {
    const door = this.spot.door
    if (!door) {
      return
    }
    const p = this.actor.root.position
    const lane = Math.sign(door[0]) * (H + 1.2)
    this.path = [
      new Vector3(lane, DECK, p.z),
      new Vector3(lane, DECK, door[1]),
      new Vector3(door[0], DECK, door[1]),
    ]
    this.mode = 'flee'
    Object.assign(this.mix, restMix())
    this.actor.play('Run', 0.15, false, RUN_SPEED / CLIP_RUN)
  }

  private run(dt: number): void {
    const p = this.actor.root.position
    const next = this.path[0]
    if (!next) {
      this.mode = 'gone'
      this.actor.root.visible = false
      return
    }
    const d = next.clone().sub(p).setY(0)
    const len = d.length()
    if (len < 0.08) {
      this.path.shift()
      return
    }
    const want = Math.atan2(d.x, d.z)
    let dy = want - this.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.yaw += dy * Math.min(1, dt * 10)
    p.addScaledVector(d.normalize(), Math.min(len, RUN_SPEED * dt))
    p.y = DECK
  }
}

/** Everyone on the porches. */
export class Townsfolk {
  readonly root: Group
  private readonly folk: Folk[] = []
  private readonly assets: Assets
  private readonly queue: Spot[]
  private building: boolean = false as boolean

  constructor(root: Group, assets: Assets, count: number) {
    this.root = root
    this.assets = assets
    this.queue = SPOTS.slice(0, count)
  }

  /** Cast one more person (spread over frames: a cast is a dress-and-fit). */
  private buildNext(): void {
    if (this.building) {
      return
    }
    const spot = this.queue.shift()
    if (!spot) {
      return
    }
    this.building = true
    const i = SPOTS.indexOf(spot)
    const { look, hat, hatColor } = lookFor(spot, this.assets, i)
    this.assets
      .lookReady(look)
      .then(() => {
        const actor = castActor(this.assets, { look, hat, hatColor })
        if (spot.base === 'woman') {
          actor.hat?.removeFromParent()
        }
        cheapen(actor.root, `folk:${spot.name}`)
        this.root.add(actor.root)
        const f = new Folk(actor, spot)
        // nobody pops into view mid-duel: he takes his place at the next fresh duel
        if (!this.reveal) {
          f.away()
        }
        this.folk.push(f)
      })
      .catch((e: unknown) => console.warn('[life] folk', e))
      .finally(() => {
        this.building = false
      })
  }

  /** Everyone back in place (a new duel). */
  home(): void {
    for (const f of this.folk) {
      f.home()
    }
  }

  call(): void {
    for (const f of this.folk) {
      f.call()
    }
  }

  shot(): void {
    for (const f of this.folk) {
      f.shot(0.5)
    }
  }

  /** A fake-out at `p`: the people within `near` metres look at it. */
  glance(p: Vector3, near = 18): void {
    for (const f of this.folk) {
      f.glanceAt(p, near)
    }
  }

  /** True while new arrivals may simply appear (the title flyover and the hub). */
  reveal: boolean = true as boolean

  /**
   * `every`: each person updates every n-th frame, staggered, at n times the step (2 = 30 Hz;
   * 4 = 15 Hz while the street holds still for the call, where the CPU budget is tightest).
   */
  update(dt: number, focus: Vector3, tense: boolean, every = 2): void {
    if (!tense) {
      this.buildNext()
    }
    this.frame++
    this.folk.forEach((f, i) => {
      const owed = (this.last[i] ?? 0) + dt
      if ((i + this.frame) % every === 0) {
        f.update(owed, focus, tense)
        this.last[i] = 0
      } else {
        this.last[i] = owed
      }
    })
  }

  private frame = 0
  /** Step owed to each person since his last update. */
  private readonly last: number[] = []

  get count(): number {
    return this.folk.length
  }
}

/** No shadows, and every heavy mesh swapped for a meshopt LOD once it's ready. */
function cheapen(root: Object3D, key: string): void {
  let n = 0
  root.traverse((o) => {
    const m = o as Object3D & { isMesh?: boolean; isSkinnedMesh?: boolean; geometry?: never }
    if (!m.isMesh) {
      return
    }
    o.castShadow = false
    const mesh = o as unknown as { geometry: import('three').BufferGeometry }
    const geo = mesh.geometry
    const tris = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3
    const target = m.isSkinnedMesh ? FOLK_TRIS : HAT_TRIS
    if (tris > target * 1.5 && geo.index) {
      lodGeometry(geo, `${key}:${n++}`, target, 0.04)
        .then((lod) => {
          mesh.geometry = lod
        })
        .catch(() => undefined)
    }
  })
}
