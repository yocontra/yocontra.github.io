import { Color, Entity, LIGHTFALLOFF_INVERSESQUARED } from 'playcanvas'
import type { GameApplication } from './application.ts'

const FULL_NIGHT_INTENSITY = 0.5
const HIERARCHY_EVENTS = ['remove', 'removehierarchy', 'insert', 'inserthierarchy'] as const

interface Fixtures {
  lights: Entity[]
  visibility: () => void
}

/** Native shadowless lights centred on the authored Frontier lenses. */
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
    if (lights.length === 0) {
      return
    }
    const visibility = () => {
      const attached = root === this.game.app.root || root.isDescendantOf(this.game.app.root)
      for (const fixture of lights) {
        if (fixture.light) {
          fixture.light.enabled = attached && this.lanterns > 0
        }
      }
    }
    this.roots.set(root, { lights, visibility })
    for (const event of HIERARCHY_EVENTS) {
      root.on(event, visibility)
    }
    visibility()
  }

  time(value: number): void {
    if (this.disposed || this.lanterns === value) {
      return
    }
    this.lanterns = value
    for (const fixtures of this.roots.values()) {
      for (const fixture of fixtures.lights) {
        if (fixture.light) {
          fixture.light.intensity = value * FULL_NIGHT_INTENSITY
        }
      }
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
    for (const light of fixtures.lights) {
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
