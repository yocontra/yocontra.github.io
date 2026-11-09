import { BLEND_NORMAL, Color, type ContainerResource, Entity, StandardMaterial } from 'playcanvas'
import { DYNAMIC_ASSETS } from '../content/manifest.ts'
import type { World } from '../ffa/sim/state.ts'
import { prepareNativeMaterials } from '../scene/native-materials.ts'
import type { GameApplication } from './application.ts'

const ITEM_KINDS = [
  'rifle',
  'shotgun',
  'dynamite',
  'strongbox',
  'bag0',
  'bag1',
  'bag2',
  'bag3',
] as const

/** Authored props show the same pickups, dropped carry and strongbox that the server tracks. */
export class FrontierItems {
  private readonly game: GameApplication
  private readonly models = new Map<keyof typeof DYNAMIC_ASSETS, ContainerResource>()
  private readonly items = new Map<string, Entity>()
  private readonly marker = new StandardMaterial()
  private tick = -1
  private disposed = false as boolean
  private readonly materialReleases: (() => void)[] = []
  private constructor(game: GameApplication) {
    this.game = game
    this.marker.diffuse = new Color(0.65, 0.47, 0.19)
    this.marker.emissive = new Color(0.22, 0.13, 0.035)
    this.marker.metalness = 0
    this.marker.opacity = 0.2
    this.marker.blendType = BLEND_NORMAL
    this.marker.depthWrite = false
    this.marker.useMetalness = true
    this.marker.update()
  }
  static async create(game: GameApplication): Promise<FrontierItems> {
    const result = new FrontierItems(game)
    try {
      await Promise.all(
        ITEM_KINDS.map(async (key) => {
          const asset = await game.loadContainer(DYNAMIC_ASSETS[key].url)
          if (result.disposed) {
            game.releaseContainer(DYNAMIC_ASSETS[key].url)
            throw new DOMException('Pickups were closed', 'AbortError')
          }
          const resource = asset.resource as ContainerResource
          try {
            const release = await prepareNativeMaterials(game, resource)
            if (result.disposed) {
              release()
              throw new DOMException('Pickups were closed', 'AbortError')
            }
            result.materialReleases.push(release)
            result.models.set(key, resource)
          } catch (error) {
            game.releaseContainer(DYNAMIC_ASSETS[key].url)
            throw error
          }
        }),
      )
      if (!game.stage.parent) {
        throw new DOMException('Pickups were closed', 'AbortError')
      }
      return result
    } catch (error) {
      result.destroy()
      throw error
    }
  }
  update(world: World | undefined): void {
    if (this.disposed || !world) {
      return
    }
    if (world.tick === this.tick) {
      return
    }
    this.tick = world.tick
    const keep = new Set<string>()
    for (const bag of world.bags) {
      const kind = `bag${Math.max(0, Math.min(3, bag.style))}` as keyof typeof DYNAMIC_ASSETS
      this.place(`bag:${bag.id}`, kind, { x: bag.x, y: 0, z: bag.z }, keep)
    }
    for (const pickup of world.pickups) {
      const spot = world.layout.pickups[pickup.spot]
      if (spot && pickup.availableAt <= world.tick) {
        this.place(
          `pickup:${pickup.spot}`,
          spot.kind,
          { x: spot.x, y: (spot.y ?? 0) + 0.15, z: spot.z, floorY: spot.y ?? 0 },
          keep,
        )
      }
    }
    if (world.strongbox) {
      const spot = world.layout.strongboxes[world.strongbox.spot]
      if (spot) {
        this.place(
          `strongbox:${world.strongbox.spot}`,
          'strongbox',
          { x: spot.x, y: spot.y ?? 0, z: spot.z },
          keep,
        )
      }
    }
    for (const fuse of world.fuses) {
      this.place(
        `fuse:${fuse.by}:${fuse.explodeAt}`,
        'dynamite',
        { x: fuse.x, y: 0.05, z: fuse.z, floorY: 0 },
        keep,
      )
    }
    for (const [key, entity] of this.items) {
      if (!keep.has(key)) {
        entity.destroy()
        this.items.delete(key)
      }
    }
  }
  private place(
    key: string,
    kind: keyof typeof DYNAMIC_ASSETS,
    at: { x: number; y: number; z: number; floorY?: number },
    keep: Set<string>,
  ): void {
    keep.add(key)
    if (this.items.has(key)) {
      return
    }
    const resource = this.models.get(kind)
    if (!resource) {
      return
    }
    const item = resource.instantiateRenderEntity({ castShadows: false, receiveShadows: true })
    item.name = key
    item.setPosition(at.x, at.y, at.z)
    this.game.stage.addChild(item)
    const marker = new Entity('pickup-marker', this.game.app)
    marker.addComponent('render', {
      type: 'cylinder',
      material: this.marker,
      castShadows: false,
      receiveShadows: false,
    })
    marker.setLocalScale(0.48, 0.004, 0.48)
    marker.setLocalPosition(0, (at.floorY ?? at.y) - at.y + 0.012, 0)
    item.addChild(marker)
    this.items.set(key, item)
  }
  destroy(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const item of this.items.values()) {
      item.destroy()
    }
    this.items.clear()
    for (const release of this.materialReleases) {
      release()
    }
    this.materialReleases.length = 0
    for (const key of this.models.keys()) {
      this.game.releaseContainer(DYNAMIC_ASSETS[key].url)
    }
    this.models.clear()
    this.marker.destroy()
  }
}
