import { Color, Entity } from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import { NativeEnvironment } from '../client/environment.ts'
import bank from '../content/bank.json' with { type: 'json' }
import depot from '../content/depot.json' with { type: 'json' }
import { ASSETS } from '../content/manifest.ts'
import mission from '../content/mission.json' with { type: 'json' }
import streetLife from '../content/street-life.json' with { type: 'json' }
import type { ArenaLife } from '../contract/ambient.ts'

export type ArenaId = 'street' | 'depot' | 'mission' | 'bank'
export type { ArenaLife, Stand } from '../contract/ambient.ts'

const STREET: ArenaLife = streetLife
const ARENAS = { depot, mission, bank }
export function arenaForSlot(slot: number): ArenaId {
  if (slot >= 6 && slot <= 9) {
    return 'depot'
  }
  if (slot >= 10 && slot <= 12) {
    return 'mission'
  }
  if (slot >= 13 && slot <= 14) {
    return 'bank'
  }
  return 'street'
}
/** One authored scene is visible; ground and distant landscape remain shared across acts. */
export class NativeArenas {
  private current: Entity | null = null
  private epoch = 0
  private currentUrl = '' as string
  private requestedUrl = '' as string
  private readonly lights: Entity[] = []
  private dailyDenseFog = false as boolean
  private lightingEpoch = 0
  private readonly game: GameApplication
  private readonly environment: NativeEnvironment
  id: ArenaId = 'street'
  life: ArenaLife = STREET
  constructor(game: GameApplication) {
    this.game = game
    this.environment = new NativeEnvironment(game)
  }
  async show(id: ArenaId): Promise<void> {
    const epoch = ++this.epoch
    const url = id === 'street' ? '' : ASSETS[id].url
    this.requestedUrl = url
    const next = url ? await this.game.instantiate(url, `arena-${id}`) : null
    if (epoch !== this.epoch) {
      next?.destroy()
      if (url && url !== this.requestedUrl && url !== this.currentUrl) {
        this.game.releaseContainer(url)
      }
      return
    }
    const previousUrl = this.currentUrl
    this.current?.destroy()
    this.current = next
    this.currentUrl = url
    if (previousUrl && previousUrl !== url) {
      this.game.releaseContainer(previousUrl)
    }
    this.id = id
    this.environment.street(id === 'street')
    const street = this.game.stage.findByName('street')
    if (street) {
      street.enabled = id === 'street'
    }
    this.life = id === 'street' ? STREET : ARENAS[id].life
    const root = next ?? this.game.stage.findByName('duel-street')
    if (root instanceof Entity) {
      const asset = await this.game.loadContainer(ASSETS[id === 'street' ? 'duel' : id].url)
      if (epoch !== this.epoch) {
        return
      }
      this.environment.attach(root, asset)
    }
    await this.environment.ready
    if (epoch !== this.epoch) {
      return
    }
    for (const light of this.lights) {
      light.destroy()
    }
    this.lights.length = 0
    const lamps =
      id === 'street'
        ? [
            [10.2, 2.9, 2],
            [-10.2, 2.9, 18],
          ]
        : ARENAS[id].lamps
    for (const [index, position] of lamps.entries()) {
      const light = new Entity(`arena-lamp-${index}`, this.game.app)
      light.addComponent('light', {
        type: 'omni',
        color: new Color(1, 0.62, 0.27),
        range: 10,
        intensity: 0,
        castShadows: false,
      })
      light.setPosition(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0)
      this.game.stage.addChild(light)
      this.lights.push(light)
    }
  }
  night(amount: number): void {
    for (const light of this.lights) {
      if (light.light) {
        light.light.intensity = Math.max(0, amount - 0.25) * 4
      }
    }
  }
  async lighting(day: number, index = 0): Promise<void> {
    const epoch = ++this.lightingEpoch
    this.night(day)
    this.environment.poster(index)
    await this.environment.setTime(day)
    if (epoch !== this.lightingEpoch) {
      return
    }
    // Native PBR uses the environment atlas; lift moonlit surfaces without adding a light.
    const night = this.dailyDenseFog ? 0 : Math.max(0, Math.min(1, (day - 0.72) / 0.28))
    this.game.app.scene.skyboxIntensity = 0.7 * (1 + night)
    this.environment.clock(day, index === 16)
  }
  toll(): void {
    this.environment.toll()
  }
  dailyFog(enabled: boolean): void {
    this.dailyDenseFog = enabled
    this.environment.dailyFog(enabled)
  }
  destroy(): void {
    this.lightingEpoch++
    this.epoch++
    this.environment.destroy()
    this.current?.destroy()
    if (this.currentUrl) {
      this.game.releaseContainer(this.currentUrl)
    }
    for (const light of this.lights) {
      light.destroy()
    }
    this.lights.length = 0
  }
}
