import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  Entity,
  FILTER_LINEAR,
  LIGHTFALLOFF_INVERSESQUARED,
  StandardMaterial,
  type Texture,
} from 'playcanvas'
import { AMBIENT_ASSETS } from '../content/ambient.ts'
import type { GameApplication } from './application.ts'

// Measured in the original lantern mesh, below the handle; parent transforms stay authored.
const LENS_Y = -0.523_209_318_518_637_7
const GLOW = 6
const FULL_NIGHT_INTENSITY = 0.5

interface Fixtures {
  material: StandardMaterial
  lights: Entity[]
  visibility: () => void
}

/** Frontier-only lens emission and native shadowless lights; materials belong to NativeEnvironment. */
export class FrontierLamps {
  private readonly game: GameApplication
  private readonly roots = new Map<Entity, Fixtures>()
  private readonly materials = new Set<StandardMaterial>()
  private texture: Texture | undefined
  private disposed = false as boolean
  private lanterns = 0
  private emission = 0
  readonly ready: Promise<void>

  constructor(game: GameApplication) {
    this.game = game
    this.ready = game
      .loadTexture(AMBIENT_ASSETS['lantern-glow'].url, {
        srgb: false,
        flipY: false,
        mipmaps: false,
      })
      .then((asset) => {
        if (this.disposed) {
          return
        }
        const texture = asset.resource as Texture
        texture.addressU = ADDRESS_CLAMP_TO_EDGE
        texture.addressV = ADDRESS_CLAMP_TO_EDGE
        texture.minFilter = FILTER_LINEAR
        texture.magFilter = FILTER_LINEAR
        texture.anisotropy = 1
        this.texture = texture
        for (const material of this.materials) {
          this.prepare(material)
        }
      })
  }

  /** A time/sky change must not replace the still-pending mask readiness. */
  readyWith(environment: Promise<void>): Promise<void> {
    return Promise.all([environment, this.ready]).then(() => undefined)
  }

  owns(material: StandardMaterial): boolean {
    return this.materials.has(material)
  }

  /** Run before native batch ownership: only the actual lantern gets this separate shared clone. */
  attach(root: Entity): void {
    if (this.disposed || this.roots.has(root)) {
      return
    }
    let material: StandardMaterial | undefined
    let source: StandardMaterial | undefined
    const lights: Entity[] = []
    for (const component of root.findComponents('render')) {
      if (component.entity.name !== 'lantern_hanging') {
        continue
      }
      let accepted = false
      for (const instance of component.meshInstances) {
        const original = instance.material
        if (!(original instanceof StandardMaterial) || original.name !== 'HalloweenBits') {
          continue
        }
        if (source && original !== source) {
          continue
        }
        source = original
        if (!material) {
          material = original.clone()
          material.name = 'Frontier lantern lenses'
          this.materials.add(material)
          this.prepare(material)
        }
        instance.material = material
        accepted = true
      }
      if (accepted) {
        const light = new Entity('frontier-lantern-light', this.game.app)
        component.entity.addChild(light)
        light.setLocalPosition(0, LENS_Y, 0)
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
    }
    if (!material) {
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
    this.roots.set(root, { material, lights, visibility })
    root.on('remove', visibility)
    root.on('removehierarchy', visibility)
    root.on('insert', visibility)
    root.on('inserthierarchy', visibility)
    visibility()
  }

  private prepare(material: StandardMaterial): void {
    material.emissiveMap = this.texture ?? null
    material.emissiveMapUv = 0
    material.emissiveMapChannel = 'r'
    material.emissive.set(1, 0.66, 0.34)
    // Without the mask there must be no whole-body emission while its async load is pending.
    material.emissiveIntensity = this.texture ? this.emission : 0
    material.update()
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

  glow(value: number, flicker: number): void {
    const emission = value * GLOW * flicker
    if (this.disposed || emission === this.emission) {
      return
    }
    this.emission = emission
    for (const material of this.materials) {
      material.emissiveIntensity = this.texture ? emission : 0
      material.update()
    }
  }

  release(root: Entity): void {
    const fixtures = this.roots.get(root)
    if (!fixtures) {
      return
    }
    for (const event of ['remove', 'removehierarchy', 'insert', 'inserthierarchy']) {
      root.off(event, fixtures.visibility)
    }
    for (const light of fixtures.lights) {
      light.destroy()
    }
    this.materials.delete(fixtures.material)
    this.roots.delete(root)
  }

  destroy(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const root of this.roots.keys()) {
      this.release(root)
    }
    this.texture = undefined
  }
}
