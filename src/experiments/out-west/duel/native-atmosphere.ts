import type { GameApplication } from '../client/application.ts'
import { DYNAMIC_ASSETS } from '../content/manifest.ts'
import { DuelActor } from './native-actor.ts'
import type { ArenaLife } from './native-arenas.ts'

type CueProp = 'coin' | 'card' | 'crow' | 'tumbleweed' | 'door' | 'dog' | 'horse'
/** Readable authored fakeouts use native skeletal and transform animation playback. */
export class NativeAtmosphere {
  private readonly props = new Map<CueProp, DuelActor>()
  private readonly transients = new Set<DuelActor>()
  private readonly game: GameApplication
  private disposed = false as boolean
  constructor(game: GameApplication) {
    this.game = game
  }
  async load(): Promise<void> {
    await Promise.all(
      (['coin', 'card', 'crow', 'tumbleweed', 'door', 'dog', 'horse'] as const).map(
        async (name) => {
          const actor = await DuelActor.create(
            this.game,
            DYNAMIC_ASSETS[name].url,
            `fakeout-${name}`,
          )
          if (this.disposed) {
            actor.destroy()
            return
          }
          actor.root.enabled = false
          this.props.set(name, actor)
        },
      ),
    )
  }
  arrange(life: ArenaLife): void {
    const dog = this.props.get('dog')
    dog?.place(life.dog.x, life.dog.y, life.dog.z)
    dog?.face((life.dog.yaw * 180) / Math.PI)
    const stand = life.horses[0]
    const horse = this.props.get('horse')
    if (stand) {
      horse?.place(stand.x, stand.y, stand.z)
      horse?.face((stand.yaw * 180) / Math.PI)
    }
    const crow = this.props.get('crow')
    crow?.place(life.crows.x, life.crows.y, life.crows.z)
    crow?.face((life.crows.face * 180) / Math.PI)
    const door = this.props.get('door')
    door?.place(life.door.x, life.door.y, life.door.z)
    door?.face((life.door.yaw * 180) / Math.PI)
    for (const name of ['dog', 'horse', 'crow'] as const) {
      const actor = this.props.get(name)
      if (actor) {
        actor.root.enabled = true
        actor.play('Idle', 0)
      }
    }
    this.transients.clear()
    for (const name of ['door', 'coin', 'card', 'tumbleweed'] as const) {
      const actor = this.props.get(name)
      if (actor) {
        actor.root.enabled = false
      }
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
    if (!kind) {
      return
    }
    const actor = this.props.get(kind)
    if (!actor) {
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
    actor.play(clips[kind] ?? 'Gun_Shoot', 0)
    this.transients.add(actor)
  }
  update(): void {
    for (const actor of this.transients) {
      if ((actor.model.anim?.baseLayer?.activeStateProgress ?? 0) < 0.98) {
        continue
      }
      if (actor === this.props.get('dog') || actor === this.props.get('horse')) {
        actor.play('Idle', 0.2)
      } else {
        actor.root.enabled = false
      }
      this.transients.delete(actor)
    }
  }
  destroy(): void {
    this.disposed = true
    for (const actor of this.props.values()) {
      actor.destroy()
    }
    this.props.clear()
    this.transients.clear()
  }
}
