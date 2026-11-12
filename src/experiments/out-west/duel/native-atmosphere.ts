import type { GameApplication } from '../client/application.ts'
import { NativeWilds } from '../client/wilds.ts'
import { AMBIENT_ASSETS } from '../content/ambient.ts'
import { ASSETS, DYNAMIC_ASSETS } from '../content/manifest.ts'
import streetLife from '../content/street-life.json' with { type: 'json' }
import { OUTLAWS } from '../data/outlaws.ts'
import { DuelActor } from './native-actor.ts'
import type { ArenaLife, Stand } from './native-arenas.ts'

type CueProp = 'coin' | 'card' | 'crow' | 'tumbleweed' | 'door' | 'dog' | 'horse'
/** Settled animals drift between their authored idles; plain Idle recurs so the swaps stay rare. */
const IDLE_VARIANTS = ['Idle', 'Idle_2', 'Idle', 'Idle_Headlow', 'Idle', 'Eating', 'Idle_2_HeadLow']
const IDLE_SPELL = 9
const HEN_RUN = [-1.6, 0.6] as const
interface Spectator {
  actor: DuelActor
  home: Stand & { habit?: string; door?: readonly number[] | null; floor?: number; seatY?: number }
  hipsHeight: number
}
function clip(actor: DuelActor, requested: string, fallback = 'Idle'): void {
  const name = actor.model.anim?.baseLayer?.states.includes(requested) ? requested : fallback
  actor.play(name, 0.18)
}

function habit(spectator: Spectator): void {
  const habits: Readonly<Record<string, string>> = {
    sit: 'Town_Sit',
    whittle: 'Town_Sit',
    rail: 'Town_Rail',
    lean: 'Town_Lean',
  }
  clip(spectator.actor, habits[spectator.home.habit ?? 'stand'] ?? 'Idle')
}

function placeSpectator(spectator: Spectator, home: Spectator['home']) {
  spectator.home = home
  const seated = home.habit === 'sit' || home.habit === 'whittle'
  const height = home.y - (seated ? spectator.hipsHeight - 0.1 : 0)
  spectator.actor.place(home.x, height, home.z)
  spectator.actor.face((home.yaw * 180) / Math.PI)
  if (seated && home.seatY !== undefined) {
    spectator.actor.play('Town_Sit', 0)
    spectator.actor.model.anim?.update(0)
    const hips = spectator.actor.model.findByName('Hips')
    if (hips) {
      const localHips = hips.getPosition().y - spectator.actor.root.getPosition().y
      spectator.actor.place(
        home.x,
        home.seatY + spectator.actor.seatedHipOffset - localHips,
        home.z,
      )
    }
  } else {
    habit(spectator)
  }
}

/** Native authored life shared by every act: nine spectators, two horses, a dog and birds. */
export class NativeAtmosphere {
  private readonly props = new Map<CueProp, DuelActor>()
  private readonly transients = new Set<DuelActor>()
  private readonly folk: Spectator[] = []
  private readonly horses: DuelActor[] = []
  private readonly crows: DuelActor[] = []
  private readonly hens: DuelActor[] = []
  private readonly idlers = new Map<
    DuelActor,
    { variants: string[]; offset: number; turn: number }
  >()
  private idleTime = 0
  private signs: DuelActor | undefined
  private wilds: NativeWilds | undefined
  private readonly game: GameApplication
  private disposed = false as boolean
  private phase = ''
  private flight = -1
  private scatter = -1
  constructor(game: GameApplication) {
    this.game = game
  }
  async load(authored: ArenaLife = streetLife): Promise<void> {
    const allocation = authored.allocation
    const fakeouts = allocation?.fakeouts !== false
    const create = async (url: string, name: string): Promise<DuelActor> => {
      const actor = await DuelActor.create(this.game, url, name)
      if (this.disposed) {
        actor.destroy()
        throw new DOMException('Town life was closed', 'AbortError')
      }
      actor.root.enabled = false
      return actor
    }
    await Promise.all([
      ...(['coin', 'card', 'tumbleweed', 'door', 'dog'] as const)
        .filter((name) => (name === 'dog' ? allocation?.dog !== false : fakeouts))
        .map(async (name) => {
          this.props.set(name, await create(DYNAMIC_ASSETS[name].url, `fakeout-${name}`))
        }),
      ...Array.from({ length: allocation?.horses ?? 2 }, async (_, index) => {
        const horse = await create(DYNAMIC_ASSETS.horse.url, `town-horse-${index}`)
        this.horses[index] = horse
        if (index === 0) {
          this.props.set('horse', horse)
        }
      }),
      ...Array.from({ length: allocation?.crows ?? 7 }, async (_, index) => {
        const crow = await create(AMBIENT_ASSETS.crow.url, `town-crow-${index}`)
        this.crows[index] = crow
        if (index === 0) {
          this.props.set('crow', crow)
        }
      }),
      ...Array.from({ length: allocation?.hens ?? 3 }, async (_, index) => {
        this.hens[index] = await create(AMBIENT_ASSETS.hen.url, `town-hen-${index}`)
      }),
      ...authored.folk
        .slice(0, allocation?.folk ?? authored.folk.length)
        .map(async (spot, index) => {
          const variant = Math.max(
            0,
            OUTLAWS.findIndex((outlaw) => outlaw.look.base === spot.base),
          )
          const source = ASSETS[`outlaw-${variant}` as keyof typeof ASSETS]
          const actor = await create(source.url, `townsfolk-${index}`)
          const hips = actor.model.findByName('Hips')
          const hipsHeight = hips ? hips.getPosition().y - actor.root.getPosition().y : 0.95
          actor.weaponsVisible(false)
          this.folk[index] = { actor, home: spot, hipsHeight }
        }),
      (async () => {
        if (!fakeouts) {
          return
        }
        this.signs = await create(AMBIENT_ASSETS.shingles.url, 'town-shingles')
      })(),
      (fakeouts ? NativeWilds.create(this.game, 'duel') : Promise.resolve(undefined)).then(
        (wilds) => {
          if (this.disposed) {
            wilds?.destroy()
          } else {
            this.wilds = wilds
          }
        },
      ),
    ])
  }
  arrange(life: ArenaLife): void {
    this.flight = -1
    this.scatter = -1
    for (const [index, spectator] of this.folk.entries()) {
      const home = life.folk[index]
      spectator.actor.root.enabled = Boolean(home)
      if (!home) {
        continue
      }
      placeSpectator(spectator, home)
    }
    for (const [index, horse] of this.horses.entries()) {
      const stand = life.horses[index]
      horse.root.enabled = Boolean(stand)
      if (stand) {
        horse.place(stand.x, stand.y, stand.z)
        horse.face((stand.yaw * 180) / Math.PI)
        this.settle(horse, index * 4.3)
      }
    }
    for (const [index, crow] of this.crows.entries()) {
      const offset = -1.5 + (index / 6) * 3
      const perch = life.crowPerches?.[index]
      crow.root.enabled = !life.crowPerches || Boolean(perch)
      crow.place(
        perch?.x ?? life.crows.x + (life.crows.along === 'x' ? offset : 0),
        perch?.y ?? life.crows.y,
        perch?.z ?? life.crows.z + (life.crows.along === 'x' ? 0 : offset),
      )
      crow.face((life.crows.face * 180) / Math.PI + index * 7)
      clip(crow, 'Idle')
    }
    for (const [index, hen] of this.hens.entries()) {
      hen.root.enabled = Boolean(life.hens)
      if (life.hens) {
        hen.place(life.hens.x + Math.sin(index * 2.4) * 0.45, 0, life.hens.z + index * 0.7)
        hen.face(index * 120)
        clip(hen, 'Idle')
      }
    }
    const dog = this.props.get('dog')
    dog?.place(life.dog.x, life.dog.y, life.dog.z)
    dog?.face((life.dog.yaw * 180) / Math.PI)
    if (dog) {
      dog.root.enabled = true
      this.settle(dog, 2.1)
    }
    const door = this.props.get('door')
    door?.place(life.door.x, life.door.y, life.door.z)
    door?.face((life.door.yaw * 180) / Math.PI)
    if (this.signs) {
      this.signs.root.enabled = life === streetLife || life.folk[0]?.x === streetLife.folk[0]?.x
      clip(this.signs, 'Wind')
    }
    this.transients.clear()
    for (const name of ['door', 'coin', 'card', 'tumbleweed'] as const) {
      const actor = this.props.get(name)
      if (actor) {
        actor.root.enabled = false
      }
    }
  }
  private settle(actor: DuelActor, offset: number): void {
    const variants = IDLE_VARIANTS.filter((name) => actor.hasAnimation(name))
    const turn = Math.floor((this.idleTime + offset) / IDLE_SPELL)
    this.idlers.set(actor, { variants, offset, turn })
    actor.idle(variants[turn % variants.length] ?? 'Idle')
    clip(actor, 'Idle')
  }
  private driftIdles(step: number): void {
    this.idleTime += step
    for (const [actor, idler] of this.idlers) {
      const turn = Math.floor((this.idleTime + idler.offset) / IDLE_SPELL)
      if (turn === idler.turn) {
        continue
      }
      idler.turn = turn
      actor.idle(idler.variants[turn % idler.variants.length] ?? 'Idle')
      if (actor.root.enabled && !this.transients.has(actor)) {
        actor.play('Idle', 0.6)
      }
    }
  }
  private takeOff(): void {
    this.flight = 0
    this.scatter = 0
    // Birds are modelled facing +Z; turn each one onto the path it is about to travel.
    for (const [index, crow] of this.crows.entries()) {
      crow.face((Math.atan2(3.4, 0.4 + index * 0.12) * 180) / Math.PI)
      clip(crow, 'Fly')
    }
    for (const [index, hen] of this.hens.entries()) {
      hen.face((Math.atan2(HEN_RUN[0], HEN_RUN[1]) * 180) / Math.PI + (index - 1) * 12)
      clip(hen, 'Scatter')
    }
  }
  cue(name: string, enemy: DuelActor | null): void {
    const kinds: Readonly<Record<string, CueProp>> = {
      dog: 'dog',
      horse: 'horse',
      crow: 'crow',
      door: 'door',
      creak: 'door',
      coin: 'coin',
      cards: 'card',
      gust: 'tumbleweed',
      tumbleweed: 'tumbleweed',
    }
    const kind = kinds[name]
    const actor = kind ? this.props.get(kind) : undefined
    if (!(actor && kind)) {
      return
    }
    if (kind === 'crow') {
      this.takeOff()
      return
    }
    const at = enemy?.root.getPosition()
    if (kind === 'coin') {
      actor.place((at?.x ?? 0) - 0.25, 1.2, (at?.z ?? 0) - 0.2)
    }
    if (kind === 'card' || kind === 'tumbleweed') {
      actor.place(0, 0, at?.z ?? 0)
    }
    actor.root.enabled = true
    const clips: Partial<Record<CueProp, string>> = { dog: 'Attack', horse: 'Idle_HitReact_Left' }
    clip(actor, clips[kind] ?? 'Gun_Shoot')
    this.transients.add(actor)
  }
  private changePhase(phase: string): void {
    if (phase && phase !== this.phase) {
      this.phase = phase
      if (phase === 'win' || phase === 'lose' || phase === 'coward') {
        this.takeOff()
        for (const horse of this.horses) {
          clip(horse, 'Idle_HitReact_Left')
          this.transients.add(horse)
        }
      }
    }
  }
  private moveBirds(step: number): void {
    if (this.flight >= 0) {
      this.flight += step
      for (const [index, crow] of this.crows.entries()) {
        if (this.flight > index * 0.06) {
          crow.root.translate(step * 3.4, step * 1.7, step * (0.4 + index * 0.12))
        }
        crow.root.enabled = this.flight < 8
      }
    }
    if (this.scatter >= 0) {
      this.scatter += step
      for (const hen of this.hens) {
        if (hen.root.enabled && this.scatter < 2) {
          hen.root.translate(step * HEN_RUN[0], 0, step * HEN_RUN[1])
        }
      }
    }
  }
  private finishCues(): void {
    for (const actor of this.transients) {
      if ((actor.model.anim?.baseLayer?.activeStateProgress ?? 0) < 0.98) {
        continue
      }
      if (actor === this.props.get('dog') || this.horses.includes(actor)) {
        clip(actor, 'Idle')
      } else {
        actor.root.enabled = false
      }
      this.transients.delete(actor)
    }
  }
  update(dt = 0, phase = ''): void {
    this.changePhase(phase)
    const step = Math.max(0, Math.min(0.1, dt))
    this.moveBirds(step)
    this.driftIdles(step)
    this.finishCues()
  }
  /** Compile the native material variants behind loading before admitting an online player. */
  warm(x: number, y: number, z: number): () => void {
    const actors = new Set([
      ...this.props.values(),
      ...this.folk.map((p) => p.actor),
      ...this.horses,
      ...this.crows,
      ...this.hens,
    ])
    const original = [...actors].map((actor) => ({
      actor,
      position: actor.root.getLocalPosition().clone(),
      enabled: actor.root.enabled,
    }))
    for (const [index, { actor }] of original.entries()) {
      actor.root.enabled = true
      actor.place(x + (index % 3) * 0.4, y, z + Math.floor(index / 3) * 0.4)
    }
    return () => {
      for (const { actor, position, enabled } of original) {
        if (actor.root.parent) {
          actor.root.setLocalPosition(position)
          actor.root.enabled = enabled
        }
      }
    }
  }
  get stats() {
    return {
      folk: this.folk.length,
      horses: this.horses.length,
      crows: this.crows.length,
      hens: this.hens.filter((hen) => hen.root.enabled).length,
    }
  }
  destroy(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.wilds?.destroy()
    const actors = new Set([
      ...this.props.values(),
      ...this.folk.map((spectator) => spectator.actor),
      ...this.horses,
      ...this.crows,
      ...this.hens,
    ])
    if (this.signs) {
      actors.add(this.signs)
    }
    for (const actor of actors) {
      actor.destroy()
    }
    this.props.clear()
    this.transients.clear()
    this.folk.length = 0
    this.horses.length = 0
    this.crows.length = 0
    this.hens.length = 0
    this.idlers.clear()
  }
}
