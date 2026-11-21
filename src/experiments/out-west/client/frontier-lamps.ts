import { Color, Entity, LIGHTFALLOFF_INVERSESQUARED, type StandardMaterial } from 'playcanvas'
import type { GameApplication } from './application.ts'
import { roomLights, saloonWindowLights } from './frontier-room-light.ts'

const FULL_NIGHT_INTENSITY = 0.5
const ROOM_DAYLIGHT_INTENSITY = 1.6
const SALOON_DAYLIGHT_INTENSITY = 1.15
const SALOON_LANTERN_INTENSITY = 1.2
const HIERARCHY_EVENTS = ['remove', 'removehierarchy', 'insert', 'inserthierarchy'] as const

interface Fixtures {
  lamps: Entity[]
  rooms: Entity[]
  saloonLamps: Entity[]
  saloonWindows: Entity[]
  visibility: () => void
}

/** Owns the town’s lanterns and indirect daylight. */
export class FrontierLamps {
  private readonly roots = new Map<Entity, Fixtures>()
  private disposed = false as boolean
  private lanterns = 0

  private readonly game: GameApplication
  constructor(game: GameApplication) {
    this.game = game
  }

  attach(root: Entity): void {
    if (this.disposed || this.roots.has(root)) {
      return
    }
    const lights: Entity[] = []
    const saloonLamps: Entity[] = []
    for (const { entity } of root.findComponents('render')) {
      const saloon = entity.name.startsWith('frontier-saloon-lamp-glass-')
      if (!(saloon || entity.name === 'frontier-lantern-glass')) {
        continue
      }
      const light = new Entity('frontier-lantern-light', this.game.app)
      entity.addChild(light)
      light.addComponent('light', {
        type: 'omni',
        color: new Color(1, 0.66, 0.34),
        falloffMode: LIGHTFALLOFF_INVERSESQUARED,
        range: saloon ? 6.2 : 9,
        intensity: 0,
        castShadows: false,
        enabled: false,
      })
      if (saloon) {
        saloonLamps.push(light)
      } else {
        lights.push(light)
      }
    }
    const rooms = root.name === 'town' ? roomLights(root, this.game.app) : []
    const saloonWindows = root.name === 'town' ? saloonWindowLights(root, this.game.app) : []
    if (lights.length === 0 && rooms.length === 0 && saloonLamps.length === 0) {
      return
    }
    const fixtures = {
      lamps: lights,
      rooms,
      saloonLamps,
      saloonWindows,
      visibility: () => this.apply(root, fixtures),
    }
    this.roots.set(root, fixtures)
    for (const event of HIERARCHY_EVENTS) {
      root.on(event, fixtures.visibility)
    }
    fixtures.visibility()
  }

  private apply(root: Entity, { lamps, rooms, saloonLamps, saloonWindows }: Fixtures): void {
    const attached = root === this.game.app.root || root.isDescendantOf(this.game.app.root)
    const lampIntensity = this.lanterns * FULL_NIGHT_INTENSITY
    const daylight = (1 - this.lanterns) * ROOM_DAYLIGHT_INTENSITY
    for (const [group, intensity] of [
      [lamps, lampIntensity],
      [rooms, daylight],
      [saloonLamps, this.lanterns * SALOON_LANTERN_INTENSITY],
      [saloonWindows, (1 - this.lanterns) * SALOON_DAYLIGHT_INTENSITY],
    ] as const) {
      for (const fixture of group) {
        if (fixture.light) {
          fixture.light.intensity = intensity
          fixture.light.enabled = attached && intensity > 0
        }
      }
    }
  }

  time(value: number): void {
    if (this.disposed || this.lanterns === value) {
      return
    }
    this.lanterns = value
    for (const fixtures of this.roots.values()) {
      fixtures.visibility()
    }
  }

  release(root: Entity): void {
    const fixtures = this.roots.get(root)
    if (!fixtures) {
      return
    }
    for (const event of HIERARCHY_EVENTS) {
      root.off(event, fixtures.visibility)
    }
    for (const light of [
      ...fixtures.lamps,
      ...fixtures.rooms,
      ...fixtures.saloonLamps,
      ...fixtures.saloonWindows,
    ]) {
      light.destroy()
    }
    this.roots.delete(root)
  }

  destroy(): void {
    this.disposed = true
    for (const root of this.roots.keys()) {
      this.release(root)
    }
  }
}

/** The interior glass has a warm flame tint with no separate emissive texture. */
export function ownLampGlass(material: StandardMaterial, node: Entity, intensity: number): void {
  if (node.name.startsWith('frontier-saloon-lamp-glass-')) {
    material.emissive.set(0.33, 0.16, 0.05)
  }
  material.emissiveIntensity = intensity
  material.update()
}
