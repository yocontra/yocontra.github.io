import { Color, Entity, LIGHTFALLOFF_INVERSESQUARED } from 'playcanvas'
import type { GameApplication } from './application.ts'
import { roomLights } from './frontier-room-light.ts'

const FULL_NIGHT_INTENSITY = 0.5
const ROOM_DAYLIGHT_INTENSITY = 1.6
const HIERARCHY_EVENTS = ['remove', 'removehierarchy', 'insert', 'inserthierarchy'] as const

interface Fixtures {
  lamps: Entity[]
  rooms: Entity[]
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
    for (const { entity } of root.findComponents('render')) {
      if (entity.name !== 'frontier-lantern-glass') {
        continue
      }
      const light = new Entity('frontier-lantern-light', this.game.app)
      entity.addChild(light)
      light.addComponent('light', {
        type: 'omni',
        color: new Color(1, 0.66, 0.34),
        falloffMode: LIGHTFALLOFF_INVERSESQUARED,
        range: 9,
        intensity: this.lanterns * FULL_NIGHT_INTENSITY,
        castShadows: false,
        enabled: false,
      })
      lights.push(light)
    }
    const rooms = root.name === 'town' ? roomLights(root, this.game.app) : []
    if (lights.length === 0 && rooms.length === 0) {
      return
    }
    const fixtures = { lamps: lights, rooms, visibility: () => this.apply(root, fixtures) }
    this.roots.set(root, fixtures)
    for (const event of HIERARCHY_EVENTS) {
      root.on(event, fixtures.visibility)
    }
    fixtures.visibility()
  }

  private apply(root: Entity, { lamps, rooms }: Fixtures): void {
    const attached = root === this.game.app.root || root.isDescendantOf(this.game.app.root)
    const lampIntensity = this.lanterns * FULL_NIGHT_INTENSITY
    const daylight = (1 - this.lanterns) * ROOM_DAYLIGHT_INTENSITY
    for (const [group, intensity] of [
      [lamps, lampIntensity],
      [rooms, daylight],
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
    for (const light of [...fixtures.lamps, ...fixtures.rooms]) {
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
