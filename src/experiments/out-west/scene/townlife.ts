/**
 * Town life: everything alive on the duel street that isn't a duellist. The townsfolk on the
 * porches, the horses at the rails, the dog, the chickens, the crows on the rail, the hanging
 * signs and the odd dust devil. Tiered: the floor tier gets fewer people and birds and no hens.
 *
 * It knows nothing of the duel's rules; the duel side (`duel/cues.ts`) tells it what happened
 * (the call, the shot, a fake-out, a new duel) and where to look.
 *
 * Budget (floor: 4 folk): townsfolk ~4k triangles and 2 draws each (body, hat), no shadows; horses,
 * dog, hens, crows and signs are one draw per species; the dust devil one point draw.
 */
import { type Color, Group, type Object3D, type Texture, type Vector3 } from 'three'
import type { Assets } from '../engine/assets.ts'
import { PROBE } from './anim-probe.ts'
import { Animals } from './animals.ts'
import type { Stand } from './beasts.ts'
import { RIG_TIME } from './critter-rig.ts'
import { Crows } from './crows.ts'
import type { FolkPlace } from './folk-spots.ts'
import { DustDevil, ScreenDoor, Shingles } from './town-motion.ts'
import { Townsfolk } from './townsfolk.ts'

/**
 * Where the town's life stands in another duel arena (scene/arenas): the same people, birds and
 * animals, moved onto that arena's porches, rails and roofs. The street's own places are the
 * default (`arrange(null)`).
 */
export interface LifeLayout {
  /** In the townsfolk's tier order (the floor tier takes the first four). */
  folk: readonly FolkPlace[]
  /** The crows' perch: centre, the run of it, and the way they face. */
  crows: { x: number; y: number; z: number; along: 'x' | 'z'; face: number }
  /** One per horse (two); a missing one hides. */
  horses: readonly Stand[]
  dog: Stand
  /** The fake-out door's hinge foot and turn (0: on a +x front, opening toward the lane). */
  door: Stand
  /** The hens' yard, or null to keep them in the coop. */
  hens: { x: number; z: number } | null
}

interface TierCounts {
  folk: number
  crows: number
  hens: number
  /** Dust devils wandering the far street. */
  devil: boolean
}

const COUNTS: Record<string, TierCounts> = {
  high: { folk: 9, crows: 7, hens: 3, devil: true },
  medium: { folk: 7, crows: 6, hens: 2, devil: true },
  floor: { folk: 4, crows: 5, hens: 0, devil: false },
  legacy: { folk: 3, crows: 4, hens: 0, devil: false },
}

export class TownLife {
  readonly root = new Group()
  readonly folk: Townsfolk
  readonly animals: Animals
  readonly crows: Crows
  private readonly devil: DustDevil | null
  readonly signs: Shingles
  readonly door: ScreenDoor

  constructor(parent: Object3D, assets: Assets, tier: string, dot: Texture) {
    const n = COUNTS[tier] ?? COUNTS.floor ?? { folk: 5, crows: 5, hens: 0, devil: false }
    this.root.name = 'town-life'
    parent.add(this.root)
    this.folk = new Townsfolk(this.root, assets, n.folk)
    this.animals = new Animals(this.root, n.hens)
    this.crows = new Crows(this.root, n.crows)
    this.signs = new Shingles(this.root)
    this.door = new ScreenDoor(this.root)
    this.devil = n.devil ? new DustDevil(this.root, dot) : null
    if (PROBE) {
      // for Playwright (perf A/B, cues, the animation audit): dev and perf-harness builds only
      Reflect.set(globalThis, '__owLife', this)
    }
  }

  /** Move everyone into another arena's places (null: the street's). */
  arrange(layout: LifeLayout | null): void {
    this.folk.arrange(layout?.folk ?? null)
    this.crows.perchAt(layout?.crows ?? null)
    this.animals.horses.tether(layout?.horses ?? null)
    this.animals.dog.place(layout?.dog ?? null)
    this.animals.hens?.yard(layout?.hens ?? null, layout === null || layout.hens !== null)
    this.door.hang(layout?.door ?? null)
    // the street's hanging shingles (SALOON, ROOMS) belong to its porches
    this.signs.mesh.visible = layout === null
  }

  /** A new duel: everyone back where they were, the crows on their rail. */
  reset(): void {
    this.folk.home()
    this.crows.reset()
    this.animals.hens?.reset()
  }

  /** The call: the town flinches. */
  call(): void {
    this.folk.call()
  }

  /** A shot rang out: folk run or duck, the crows and hens bolt, the horses throw their heads. */
  shot(): void {
    this.folk.shot()
    this.crows.takeOff()
    this.animals.hens?.scatter()
    this.animals.horses.toss()
  }

  /** A fake-out at `p`: the nearby folk look at it. */
  glance(p: Vector3): void {
    this.folk.glance(p)
  }

  /**
   * `dt` is game time (slow-mo slows the town too); `focus` is what the folk watch; `tense`
   * while the street waits for the call (eyes fixed, no new dust devils, nobody being built);
   * `still` while nothing moves but the wait (the people and animals animate at 15 Hz).
   */
  update(
    dt: number,
    o: { focus: Vector3; tense: boolean; still: boolean; pixelRatio: number; dust: Color },
  ): void {
    RIG_TIME.value += dt
    const every = o.still ? 4 : 2
    this.folk.update(dt, o.focus, o.tense, every)
    this.animals.update(dt, every)
    this.crows.update(dt)
    this.door.update(dt)
    this.devil?.setColor(o.dust)
    this.devil?.update(dt, o.pixelRatio, !o.tense)
  }
}

/** The live town (set by game.ts), for the duel's cues to reach. */
export const LIFE: { town: TownLife | null } = { town: null }
