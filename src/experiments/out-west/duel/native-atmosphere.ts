import type { GameApplication } from '../client/application.ts'
import { NativeWilds } from '../client/wilds.ts'
import { AMBIENT_ASSETS } from '../content/ambient.ts'
import { ASSETS, DYNAMIC_ASSETS } from '../content/manifest.ts'
import streetLife from '../content/street-life.json' with { type: 'json' }
import { OUTLAWS } from '../data/outlaws.ts'
import { DuelActor } from './native-actor.ts'
import type { ArenaLife, Stand } from './native-arenas.ts'

type CueProp = 'coin' | 'card' | 'crow' | 'tumbleweed' | 'door' | 'dog' | 'horse'
interface Spectator {
  actor: DuelActor
  home: Stand & { habit?: string; door?: readonly number[] | null; floor?: number }
  hipsHeight: number
  running: boolean
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

/** Native authored life shared by every act: nine spectators, two horses, a dog and birds. */
export class NativeAtmosphere {
  private readonly props = new Map<CueProp, DuelActor>()
  private readonly transients = new Set<DuelActor>()
  private readonly folk: Spectator[] = []
  private readonly horses: DuelActor[] = []
  private readonly crows: DuelActor[] = []
  private readonly hens: DuelActor[] = []
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
  async load(): Promise<void> {
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
      ...(['coin', 'card', 'tumbleweed', 'door', 'dog'] as const).map(async (name) => {
        this.props.set(name, await create(DYNAMIC_ASSETS[name].url, `fakeout-${name}`))
      }),
      ...Array.from({ length: 2 }, async (_, index) => {
        const horse = await create(DYNAMIC_ASSETS.horse.url, `town-horse-${index}`)
        this.horses[index] = horse
        if (index === 0) {
          this.props.set('horse', horse)
        }
      }),
      ...Array.from({ length: 7 }, async (_, index) => {
        const crow = await create(AMBIENT_ASSETS.crow.url, `town-crow-${index}`)
        this.crows[index] = crow
        if (index === 0) {
          this.props.set('crow', crow)
        }
      }),
      ...Array.from({ length: 3 }, async (_, index) => {
        this.hens[index] = await create(AMBIENT_ASSETS.hen.url, `town-hen-${index}`)
      }),
      ...streetLife.folk.map(async (spot, index) => {
        const variant = Math.max(
          0,
          OUTLAWS.findIndex((outlaw) => outlaw.look.base === spot.base),
        )
        const source = ASSETS[`outlaw-${variant}` as keyof typeof ASSETS]
        const actor = await create(source.url, `townsfolk-${index}`)
        const hips = actor.model.findByName('Hips')
        const hipsHeight = hips ? hips.getPosition().y - actor.root.getPosition().y : 0.95
        this.folk[index] = { actor, home: spot, hipsHeight, running: false }
      }),
      (async () => {
        this.signs = await create(AMBIENT_ASSETS.shingles.url, 'town-shingles')
      })(),
      NativeWilds.create(this.game, 'duel').then((wilds) => {
        if (this.disposed) {
          wilds.destroy()
        } else {
          this.wilds = wilds
        }
      }),
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
      spectator.home = home
      spectator.running = false
      const seated = home.habit === 'sit' || home.habit === 'whittle'
      const height = home.y - (seated ? spectator.hipsHeight - 0.1 : 0)
      spectator.actor.place(home.x, height, home.z)
      spectator.actor.face((home.yaw * 180) / Math.PI)
      habit(spectator)
    }
    for (const [index, horse] of this.horses.entries()) {
      const stand = life.horses[index]
      horse.root.enabled = Boolean(stand)
      if (stand) {
        horse.place(stand.x, stand.y, stand.z)
        horse.face((stand.yaw * 180) / Math.PI)
        clip(horse, 'Idle')
      }
    }
    for (const [index, crow] of this.crows.entries()) {
      const offset = -1.5 + (index / 6) * 3
      crow.root.enabled = true
      crow.place(
        life.crows.x + (life.crows.along === 'x' ? offset : 0),
        life.crows.y,
        life.crows.z + (life.crows.along === 'x' ? 0 : offset),
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
      clip(dog, 'Idle')
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
  private takeOff(): void {
    this.flight = 0
    this.scatter = 0
    for (const crow of this.crows) {
      clip(crow, 'Fly')
    }
    for (const hen of this.hens) {
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
    for (const spectator of this.folk) {
      if (spectator.actor.root.enabled) {
        clip(spectator.actor, 'Town_Flinch')
      }
    }
  }
  private changePhase(phase: string): void {
    if (phase && phase !== this.phase) {
      this.phase = phase
      if (phase === 'call') {
        for (const spectator of this.folk) {
          clip(spectator.actor, 'Town_Flinch')
        }
      }
      if (phase === 'win' || phase === 'lose' || phase === 'coward') {
        this.takeOff()
        for (const spectator of this.folk) {
          spectator.running = Boolean(spectator.home.door)
          clip(spectator.actor, spectator.running ? 'Run' : 'Town_Duck')
        }
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
          hen.root.translate(-step * 1.6, 0, step * 0.6)
        }
      }
    }
  }
  private moveFolk(step: number): void {
    for (const spectator of this.folk) {
      const door = spectator.home.door
      if (!(spectator.running && door)) {
        continue
      }
      const position = spectator.actor.root.getPosition()
      spectator.actor.root.setPosition(position.x, spectator.home.floor ?? 0.34, position.z)
      const dx = (door[0] ?? position.x) - position.x
      const dz = (door[1] ?? position.z) - position.z
      const distance = Math.hypot(dx, dz)
      if (distance < 0.12) {
        spectator.actor.root.enabled = false
        spectator.running = false
      } else {
        const move = Math.min(distance, step * 2.1)
        spectator.actor.root.translate((dx / distance) * move, 0, (dz / distance) * move)
        spectator.actor.face((Math.atan2(dx, dz) * 180) / Math.PI)
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
    this.moveFolk(step)
    this.finishCues()
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
  }
}
