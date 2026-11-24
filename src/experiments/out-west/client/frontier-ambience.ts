/**
 * The town's own sound: a wind bed that thins indoors and fills out in the open, the saloon's
 * murmur from its doors, the idling locomotive in the rail yard, and the life on its authored
 * spots (crows on their perches, the dog, the tethered horse, signs creaking on the storefronts, a
 * hawk overhead, a whistle down the line). All of it leans back under a showdown.
 */
import { TOWN } from '../ffa/sim/layout.ts'
import type { Emitter, FrontierAudio, Point } from './frontier-audio.ts'
import { clamp01, db, RANGES, SOUNDS, slider } from './frontier-sounds.ts'

type BedName = 'wind' | 'murmur' | 'loco'
interface Bed {
  emitter: Emitter
  level: number
}
interface Event {
  due: number
  lo: number
  hi: number
  run: () => void
}

/** The wind bed's level per space. */
const WIND = { open: 0.8, street: 0.6, interior: 0.25 } as const
const SIGN_FRONTS: ReadonlySet<string> = new Set(['saloon', 'hotel', 'general_store', 'stage_line'])

const centre = (r: { x: number; z: number; w: number; d: number }, y: number): Point => ({
  x: r.x + r.w / 2,
  y,
  z: r.z + r.d / 2,
})
const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(Math.random() * list.length)]

export class FrontierAmbience {
  private readonly audio: FrontierAudio
  private readonly beds = new Map<BedName, Bed>()
  private readonly events: Event[] = []
  private readonly saloonBuilding = TOWN.buildings.find((building) => building.kind === 'saloon')
  private shelter = 0
  private wind: number = WIND.street
  private readonly saloon: Point | null
  private readonly yard: Point | null

  constructor(audio: FrontierAudio) {
    this.audio = audio
    const saloon = this.saloonBuilding
    const car = TOWN.cover.find((c) => c.kind === 'boxcar')
    this.saloon = saloon ? centre(saloon, 1.4) : null
    this.yard = car ? centre(car, 1.5) : null
  }

  update(dt: number): void {
    const duck = this.audio.duck
    const { kind, building } = this.audio.space
    // Crossing a doorway changes the direct sound over several footsteps.
    const blend = 1 - Math.exp(-dt / 0.35)
    this.wind += (WIND[kind] - this.wind) * blend
    const behindWalls = kind === 'interior' && building !== this.saloonBuilding?.id ? 1 : 0
    this.shelter += (behindWalls - this.shelter) * blend
    this.bed('wind', null, this.wind * duck)
    if (this.saloon) {
      this.bed('murmur', this.saloon, 0.9 * (1 - 0.72 * this.shelter) * duck)
    }
    if (this.yard) {
      this.bed('loco', this.yard, 0.8 * Math.min(1, this.wind / WIND.street) * duck)
    }
    if (this.events.length === 0) {
      this.schedule()
    }
    const clock = this.audio.clock
    for (const e of this.events) {
      if (clock >= e.due) {
        e.run()
        e.due = clock + e.lo + Math.random() * (e.hi - e.lo)
      }
    }
  }

  private bed(name: BedName, at: Point | null, wanted: number): void {
    const level = wanted * slider(name)
    const have = this.beds.get(name)
    if (have) {
      if (Math.abs(have.level - level) > 0.01 || (level === 0 && have.level !== 0)) {
        have.level = level
        for (const instance of have.emitter.sound.slot(name)?.instances ?? []) {
          instance.volume = clamp01(level * db(SOUNDS[name].trim))
        }
      }
      return
    }
    const asset = this.audio.assetOf(name)
    const ctx = this.audio.context
    if (!(asset && ctx)) {
      return
    }
    const emitter = this.audio.emitter(`bed-${name}`, at !== null)
    if (at) {
      emitter.entity.setPosition(at.x, at.y, at.z)
      const r = RANGES.amb
      emitter.sound.distanceModel = r.model
      emitter.sound.refDistance = r.ref
      emitter.sound.maxDistance = r.max
      emitter.sound.rollOffFactor = r.rolloff
    }
    const loop = SOUNDS[name].loop
    const instance = emitter.sound
      .addSlot(name, {
        asset: asset.id,
        loop: true,
        volume: clamp01(level * db(SOUNDS[name].trim)),
        startTime: loop.start,
        duration: loop.end - loop.start,
      })
      ?.play()
    if (instance) {
      this.audio.chain(ctx, instance)
    }
    this.beds.set(name, { emitter, level })
  }

  private every(lo: number, hi: number, run: () => void): void {
    this.events.push({ due: this.audio.clock + lo + Math.random() * (hi - lo), lo, hi, run })
  }

  private schedule(): void {
    const life = TOWN.ambient
    const audio = this.audio
    const saloon = this.saloonBuilding
    const counter =
      saloon &&
      TOWN.cover.find(
        (item) =>
          item.kind === 'counter' &&
          item.x >= saloon.x &&
          item.z >= saloon.z &&
          item.x + item.w <= saloon.x + saloon.w &&
          item.z + item.d <= saloon.z + saloon.d,
      )
    if (counter?.top !== undefined) {
      const top = centre(counter, counter.top)
      this.every(10, 23, () =>
        audio.play('crockery', top, {
          pitch: 0.93 + Math.random() * 0.14,
          volume: audio.duck,
          range: 'foley',
          occlude: { hz: 1300, gain: 0.3 },
          space: 0.12,
        }),
      )
    }
    const perches = life?.crowPerches ?? []
    this.every(8, 20, () => {
      const p = pick(perches)
      if (p) {
        audio.play('crow', p, {
          range: 'amb',
          pitch: 0.9 + Math.random() * 0.2,
          volume: audio.duck,
        })
      }
    })
    const dog = life?.dog
    if (dog) {
      this.every(18, 40, () =>
        audio.play('dog', { ...dog, y: 0.5 }, { range: 'amb', pitch: 0.95 + Math.random() * 0.1 }),
      )
    }
    const horse = life?.horses?.[0]
    if (horse) {
      this.every(14, 30, () => audio.play('horse', { ...horse, y: 1.5 }, { range: 'amb' }))
    }
    this.every(35, 70, () => {
      const ear = audio.listener
      audio.play('hawk', { x: ear.x + 40, y: 60, z: ear.z - 30 }, { range: 'far', volume: 0.7 })
    })
    const fronts = TOWN.buildings.filter((b) => SIGN_FRONTS.has(b.kind))
    this.every(5, 12, () => {
      const b = pick(fronts)
      if (b) {
        audio.play(
          'creak',
          { x: b.x + b.w / 2, y: 3.2, z: b.z + b.d },
          { range: 'amb', volume: audio.duck },
        )
      }
    })
    const yard = this.yard
    if (yard) {
      this.every(50, 110, () =>
        audio.play(
          'whistle',
          { ...yard, x: yard.x - 30, y: 4 },
          { range: 'far', volume: 0.8 * audio.duck },
        ),
      )
    }
  }

  destroy(): void {
    for (const b of this.beds.values()) {
      b.emitter.entity.destroy()
    }
    this.beds.clear()
    this.events.length = 0
  }
}
