import { Color, Entity } from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import bank from '../content/bank.json' with { type: 'json' }
import depot from '../content/depot.json' with { type: 'json' }
import { ASSETS } from '../content/manifest.ts'
import mission from '../content/mission.json' with { type: 'json' }

export type ArenaId = 'street' | 'depot' | 'mission' | 'bank'
interface Stand {
  x: number
  y: number
  z: number
  yaw: number
}
export interface ArenaLife {
  dog: Stand
  horses: readonly Stand[]
  crows: { x: number; y: number; z: number; face: number }
  door: Stand
  folk: readonly Stand[]
}
const STREET: ArenaLife = {
  dog: { x: 10.05, y: 0.34, z: 25.4, yaw: -Math.PI / 2 },
  horses: [
    { x: 7.15, y: 0, z: 4.4, yaw: Math.PI / 2 },
    { x: -7.15, y: 0, z: 16.2, yaw: -Math.PI / 2 },
  ],
  crows: { x: -8.4, y: 1, z: 28, face: Math.PI / 2 },
  door: { x: 10.7, y: 1.35, z: 2, yaw: 0 },
  folk: [
    { x: 10, y: 0.34, z: 16, yaw: -1.6 },
    { x: -10, y: 0.34, z: 20, yaw: 1.6 },
    { x: 10, y: 0.34, z: 29, yaw: -1.6 },
  ],
}
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
  private readonly lights: Entity[] = []
  private readonly game: GameApplication
  id: ArenaId = 'street'
  life: ArenaLife = STREET
  constructor(game: GameApplication) {
    this.game = game
  }
  async show(id: ArenaId): Promise<void> {
    const epoch = ++this.epoch
    const next = id === 'street' ? null : await this.game.instantiate(ASSETS[id].url, `arena-${id}`)
    if (epoch !== this.epoch) {
      next?.destroy()
      return
    }
    this.current?.destroy()
    this.current = next
    this.id = id
    const street = this.game.stage.findByName('street')
    if (street) {
      street.enabled = id === 'street'
    }
    this.life = id === 'street' ? STREET : ARENAS[id].life
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
  destroy(): void {
    this.epoch++
    this.current?.destroy()
    for (const light of this.lights) {
      light.destroy()
    }
    this.lights.length = 0
  }
}
