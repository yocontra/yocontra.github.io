import { AMBIENT_ASSETS } from '../content/ambient.ts'
import { DuelActor } from '../duel/native-actor.ts'
import type { GameApplication } from './application.ts'

/** Native authored hour poses and bell swing replace the original per-vertex spin shader. */
export class NativeClockwork {
  private boss = false as boolean
  private readonly hands: DuelActor
  private readonly bell: DuelActor
  private constructor(hands: DuelActor, bell: DuelActor) {
    this.hands = hands
    this.bell = bell
    for (const component of hands.root.findComponents('render')) {
      if (component.entity.name === 'clock-bell') {
        component.entity.enabled = false
      }
    }
    for (const component of bell.root.findComponents('render')) {
      if (component.entity.name !== 'clock-bell') {
        component.entity.enabled = false
      }
    }
    const track = bell.tracks.find((candidate) => candidate.name === 'Toll')
    if (track) {
      bell.model.anim?.baseLayer?.assignAnimation('Toll', track, 1, false)
    }
  }
  static async create(game: GameApplication): Promise<NativeClockwork> {
    const [hands, bell] = await Promise.all([
      DuelActor.create(game, AMBIENT_ASSETS.clockwork.url, 'town-clock-hands'),
      DuelActor.create(game, AMBIENT_ASSETS.clockwork.url, 'town-clock-bell'),
    ])
    return new NativeClockwork(hands, bell)
  }
  visible(value: boolean): void {
    this.hands.root.enabled = value
    this.bell.root.enabled = value
  }
  time(day: number, boss: boolean): void {
    this.boss = boss
    const hour = day < 0.5 ? 12 + Math.round(day * 12) : Math.round(day * 12)
    this.hands.play(boss ? 'Clock_11_59' : `Clock_${hour % 12}`, 0.12)
  }
  toll(): void {
    if (this.boss) {
      this.hands.play('Clock_0', 0.12)
    }
    this.bell.model.anim?.baseLayer?.play('Toll')
  }
  destroy(): void {
    this.hands.destroy()
    this.bell.destroy()
  }
}
