import {
  ADDRESS_CLAMP_TO_EDGE,
  AnimTrack,
  type Asset,
  Color,
  type ContainerResource,
  DETAILMODE_MUL,
  Entity,
  FOG_EXP2,
  FOG_LINEAR,
  PIXELFORMAT_RGBA8,
  Quat,
  type RenderComponent,
  SEMANTIC_POSITION,
  StandardMaterial,
  Texture,
  TYPE_FLOAT32,
  Vec2,
  Vec3,
} from 'playcanvas'
import { AMBIENT_ASSETS } from '../content/ambient.ts'
import lighting from '../content/lighting.json' with { type: 'json' }
import { SKIES } from '../content/skies.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import { drawPoster } from '../ui/poster.ts'
import type { GameApplication } from './application.ts'
import { NativeClockwork } from './clockwork.ts'
import { NativeWilds } from './wilds.ts'

const UP = new Vec3(0, 1, 0)
const FRONTIER_SUN = new Vec3(-0.55, 0.62, 0.56).normalize()
function color(rgb: readonly number[]): Color {
  return new Color(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0).gamma()
}

function animateWind(root: Entity, asset: Asset): void {
  const resource = asset.resource as ContainerResource
  const wind = resource.animations.find(
    (clip) => clip.name === 'Wind' || clip.resource?.name === 'Wind',
  )?.resource
  if (wind instanceof AnimTrack) {
    root.addComponent('anim', { activate: true })
    root.anim?.loadStateGraph({
      layers: [
        {
          name: 'Environment',
          states: [{ name: 'START' }, { name: 'Wind', speed: 1, loop: true }],
          transitions: [{ from: 'START', to: 'Wind' }],
        },
      ],
      parameters: {},
    })
    root.anim?.baseLayer?.assignAnimation('Wind', wind)
  }
}

function canBatch(component: RenderComponent): boolean {
  const batchable = component.meshInstances.every(
    (instance) =>
      !(instance.skinInstance || instance.morphInstance) &&
      instance.mesh?.vertexBuffer.format.elements.find(
        (element) => element.name === SEMANTIC_POSITION,
      )?.dataType === TYPE_FLOAT32,
  )
  return batchable
}

/** Authored light/sky presets, native wind clips and spatial static batches for one scene. */
export class NativeEnvironment {
  private readonly game: GameApplication
  private readonly frontier: boolean
  private readonly groups = new Map<Entity, number[]>()
  private readonly materials = new Set<StandardMaterial>()
  private readonly windows = new Set<StandardMaterial>()
  private readonly posterMaterials = new Set<StandardMaterial>()
  private readonly posterLights = new Set<Entity>()
  private readonly posterNodes = new Set<Entity>()
  private posterLightIntensity = 0
  private readonly cloudMaterials = new Set<StandardMaterial>()
  private readonly groundMaterials = new Set<StandardMaterial>()
  private cloudTexture: Texture | undefined
  private groundTexture: Texture | undefined
  private cloudTime = 0
  private readonly cloudOffset = new Vec2()
  private posterTexture: Texture | undefined
  private posterCanvas: HTMLCanvasElement | undefined
  private readonly portraits = new Map<number, HTMLCanvasElement>()
  private printed: { index: number; stamp: 'coward' | 'dead' | null } | null = null
  private sky = ''
  private disposed = false as boolean
  private wilds: NativeWilds | undefined
  private clockwork: NativeClockwork | undefined
  private streetVisible = true as boolean
  private denseFog = false as boolean
  private readonly fogColor = new Color()
  private fogStart = 0
  private fogEnd = 0
  ready: Promise<void> = Promise.resolve()
  constructor(game: GameApplication, frontier = false) {
    this.game = game
    this.frontier = frontier
    this.ready = Promise.all([
      this.setTime(frontier ? 0.3 : 0),
      game
        .loadTexture(AMBIENT_ASSETS['cloud-shadow'].url, { srgb: true, flipY: false })
        .then((asset) => {
          if (!this.disposed) {
            this.cloudTexture = asset.resource as Texture
            for (const material of this.cloudMaterials) {
              this.applyClouds(material)
            }
          }
        }),
      frontier
        ? Promise.resolve()
        : game
            .loadTexture(AMBIENT_ASSETS['ground-detail'].url, { srgb: true, flipY: false })
            .then((asset) => {
              if (!this.disposed) {
                this.groundTexture = asset.resource as Texture
                this.groundTexture.addressU = ADDRESS_CLAMP_TO_EDGE
                this.groundTexture.addressV = ADDRESS_CLAMP_TO_EDGE
                for (const material of this.groundMaterials) {
                  this.applyGround(material)
                }
              }
            }),
    ]).then(() => undefined)
    if (frontier) {
      this.ready = Promise.all([
        this.ready,
        NativeWilds.create(game, 'frontier').then((wilds) => {
          if (this.disposed) {
            wilds.destroy()
          } else {
            this.wilds = wilds
          }
        }),
      ]).then(() => undefined)
    } else {
      this.ready = Promise.all([
        this.ready,
        NativeClockwork.create(game).then((clockwork) => {
          if (this.disposed) {
            clockwork.destroy()
          } else {
            clockwork.visible(this.streetVisible)
            this.clockwork = clockwork
          }
        }),
      ]).then(() => undefined)
    }
    game.app.once('destroy', () => this.destroy())
    game.app.on('update', this.updateClouds)
  }
  street(value: boolean): void {
    this.streetVisible = value
    this.clockwork?.visible(value)
  }
  clock(day: number, boss: boolean): void {
    this.clockwork?.time(day, boss)
  }
  toll(): void {
    this.clockwork?.toll()
  }
  /** The visible clock face's centre, for the duel's clock inserts. */
  clockFace(): Vec3 | null {
    return this.streetVisible ? (this.clockwork?.face() ?? null) : null
  }
  /** His mugshot for poster `index`; reprinted at once if that poster is up. */
  portrait(index: number, print: HTMLCanvasElement): void {
    this.portraits.set(index, print)
    if (this.printed?.index === index) {
      this.poster(index, this.printed.stamp)
    }
  }
  /** The poster as currently printed (stamps included), for the result card. */
  posterImage(): string | null {
    return this.posterCanvas?.toDataURL('image/jpeg', 0.8) ?? null
  }
  /** The visible wanted paper's centre and the way it faces, for the poster shot. */
  posterAnchor(): { center: Vec3; normal: Vec3 } | null {
    for (const node of this.posterNodes) {
      if (!(node.enabled && node.parent?.enabled && node.render)) {
        continue
      }
      const box = node.render.meshInstances[0]?.aabb
      if (!box) {
        continue
      }
      const center = box.center.clone()
      const h = box.halfExtents
      const normal =
        h.x < h.z
          ? new Vec3(-Math.sign(center.x) || 1, 0, 0)
          : new Vec3(0, 0, -Math.sign(center.z) || 1)
      return { center, normal }
    }
    return null
  }
  private readonly updateClouds = (dt: number): void => {
    this.cloudTime = (this.cloudTime + dt) % 3600
    this.cloudOffset.set((-this.cloudTime * 7.5) / 1024, (-this.cloudTime * 2.5) / 1024)
    for (const material of this.cloudMaterials) {
      material.diffuseDetailMapOffset = this.cloudOffset
      material.update()
    }
  }
  private applyClouds(material: StandardMaterial): void {
    material.diffuseDetailMap = this.cloudTexture ?? null
    material.diffuseDetailMapUv = 1
    material.diffuseDetailMode = DETAILMODE_MUL
    material.update()
  }
  private applyGround(material: StandardMaterial): void {
    material.diffuseDetailMap = this.groundTexture ?? null
    material.diffuseDetailMapUv = 1
    material.diffuseDetailMode = DETAILMODE_MUL
    material.update()
  }
  setTime(day: number): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const preset = lighting[Math.max(0, Math.min(lighting.length - 1, Math.round(day * 20)))]
    if (!preset) {
      return Promise.resolve()
    }
    const scene = this.game.app.scene
    const elevation = (preset.sunElev * Math.PI) / 180
    const azimuth = (preset.sunAz * Math.PI) / 180
    const direction = this.frontier
      ? FRONTIER_SUN
      : new Vec3(
          Math.sin(azimuth) * Math.cos(elevation),
          Math.max(0.12, Math.sin(elevation)),
          Math.cos(azimuth) * Math.cos(elevation),
        ).normalize()
    const sun = this.game.app.root.findByName('sun')
    if (sun instanceof Entity && sun.light) {
      sun.setRotation(new Quat().setFromDirections(UP, direction))
      // The authored irradiance used a Lambert BRDF with 1/pi; native diffuse light is cosine-only.
      const irradiance = (preset.sunIntensity / Math.PI) * (this.frontier ? 0.8 : 1)
      // Native's legacy intensity<1 branch gamma-converts intensity with color; keep energy linear.
      sun.light.color = color(preset.sunColor.map((channel) => channel * Math.min(1, irradiance)))
      sun.light.intensity = Math.max(1, irradiance)
      sun.light.shadowDistance = this.frontier ? 55 : 65
    }
    scene.exposure = preset.exposure
    const fill = color(preset.hemiSky)
    fill.mulScalar(preset.hemiIntensity * 0.2)
    scene.ambientLight.copy(fill)
    this.fogColor.copy(color(preset.fog))
    // Leave nearby combat clear while the town's distant foliage and hills fade into dust.
    this.fogStart = this.frontier ? 25 : preset.fogNear
    this.fogEnd = this.frontier ? 110 : preset.fogFar
    this.applyFog()
    for (const material of this.windows) {
      material.emissive.copy(color([1, 0.32, 0.06]))
      material.emissiveIntensity = preset.windows * 1.6
      material.update()
    }
    this.posterLightIntensity = Math.max(0, Math.min(1, (day - 0.6) / 0.2)) * 1.2
    this.updatePosterLights()
    const sky = Object.values(SKIES).reduce((nearest, candidate) =>
      Math.abs(candidate.day - day) < Math.abs(nearest.day - day) ? candidate : nearest,
    )
    if (sky.url !== this.sky) {
      this.sky = sky.url
      this.ready = this.game.environment(sky.url, 0.7, sky.day >= 0.75 ? 1024 : 256)
    }
    return this.ready
  }
  private updatePosterLights(): void {
    // The wanted post is shared across arenas; its entity hierarchy owns light visibility.
    for (const fixture of this.posterLights) {
      if (fixture.light) {
        fixture.light.intensity = this.posterLightIntensity
        fixture.light.enabled = this.posterLightIntensity > 0
      }
    }
  }
  dailyFog(enabled: boolean): void {
    if (this.disposed) {
      return
    }
    this.denseFog = enabled
    this.applyFog()
  }
  private applyFog(): void {
    const fog = this.game.app.scene.fog
    fog.type = this.denseFog ? FOG_EXP2 : FOG_LINEAR
    if (this.denseFog) {
      fog.color.set(0.6, 0.58, 0.53)
    } else {
      fog.color.copy(this.fogColor)
    }
    fog.density = this.denseFog ? 0.07 : 0
    fog.start = this.fogStart
    fog.end = this.fogEnd
  }
  poster(index: number, stamp: 'coward' | 'dead' | null = null): void {
    const outlaw = OUTLAWS[index]
    if (!outlaw || this.disposed) {
      return
    }
    this.posterCanvas ??= document.createElement('canvas')
    this.printed = { index, stamp }
    drawPoster(this.posterCanvas, outlaw, {
      index,
      stamp,
      portrait: this.portraits.get(index) ?? null,
    })
    this.posterTexture ??= new Texture(this.game.app.graphicsDevice, {
      name: 'campaign-wanted-poster',
      format: PIXELFORMAT_RGBA8,
      srgb: true,
      flipY: true,
      mipmaps: true,
      anisotropy: 4,
    })
    this.posterTexture.setSource(this.posterCanvas)
    for (const material of this.posterMaterials) {
      material.diffuseMap = this.posterTexture
      material.emissiveMap = null
      material.emissive.set(0, 0, 0)
      material.emissiveIntensity = 0
      material.update()
    }
  }
  private ownMaterial(
    original: StandardMaterial,
    clones: Map<StandardMaterial, StandardMaterial>,
    node: Entity,
  ): StandardMaterial {
    const nodeName = node.name
    if (original.name === 'WantedPaper') {
      this.posterNodes.add(node)
    }
    let material = clones.get(original)
    if (!material) {
      material = original.clone()
      clones.set(original, material)
      this.materials.add(material)
    }
    if (material.name === 'WantedPaper') {
      this.posterMaterials.add(material)
    }
    if (nodeName.startsWith('windows-') || material.name === 'Dial') {
      this.windows.add(material)
    }
    if (!this.frontier && nodeName.startsWith('ground-')) {
      this.groundMaterials.add(material)
      this.applyGround(material)
    } else if (material.opacity === 1 && !material.emissiveMap && material.name !== 'WantedPaper') {
      this.cloudMaterials.add(material)
      this.applyClouds(material)
    }
    return material
  }
  attach(root: Entity, asset: Asset): void {
    if (this.disposed || this.groups.has(root)) {
      return
    }
    animateWind(root, asset)
    const group = this.game.app.batcher?.addGroup('environment', false, 32)
    // Native RenderComponent enable/disable dirties only this group when a pane breaks or resets.
    const panes = this.game.app.batcher?.addGroup('environment-panes', false, 32)
    const clones = new Map<StandardMaterial, StandardMaterial>()
    for (const component of root.findComponents('render')) {
      // Authored additive light shafts are illumination, never opaque shadow casters.
      if (component.entity.name.startsWith('shaft-')) {
        component.castShadows = false
      }
      for (const instance of component.meshInstances) {
        const original = instance.material
        if (!(original instanceof StandardMaterial)) {
          continue
        }
        instance.material = this.ownMaterial(original, clones, component.entity)
        if (
          component.entity.name.startsWith('flora-') ||
          component.entity.name.startsWith('impostors-')
        ) {
          instance.castShadow = false
        }
      }
      const pane = component.entity.name.startsWith('glass-')
      if (pane) {
        component.castShadows = false
      }
      const target = pane ? panes : group
      if (target && canBatch(component)) {
        component.batchGroupId = target.id
      }
    }
    const ids = [group, panes].flatMap((entry) => (entry ? [entry.id] : []))
    this.groups.set(root, ids)
    const posterLight = root.findByName('poster-lantern-light')
    if (posterLight instanceof Entity) {
      posterLight.addComponent('light', {
        type: 'omni',
        color: new Color(1, 0.62, 0.27),
        range: 2.5,
        intensity: 0,
        castShadows: false,
      })
      this.posterLights.add(posterLight)
      this.updatePosterLights()
    }
    this.game.app.batcher?.generate(ids)
    if (this.posterMaterials.size > 0) {
      this.poster(0)
    }
    root.once('destroy', () => {
      if (posterLight instanceof Entity) {
        this.posterLights.delete(posterLight)
      }
      for (const node of this.posterNodes) {
        if (node === root || node.isDescendantOf(root)) {
          this.posterNodes.delete(node)
        }
      }
      for (const id of this.groups.get(root) ?? []) {
        this.game.app.batcher?.removeGroup(id)
      }
      this.groups.delete(root)
      for (const material of clones.values()) {
        this.windows.delete(material)
        this.posterMaterials.delete(material)
        this.cloudMaterials.delete(material)
        this.groundMaterials.delete(material)
        this.materials.delete(material)
        material.destroy()
      }
    })
  }
  destroy(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.game.app.off('update', this.updateClouds)
    this.wilds?.destroy()
    this.clockwork?.destroy()
    for (const ids of this.groups.values()) {
      for (const id of ids) {
        this.game.app.batcher?.removeGroup(id)
      }
    }
    this.groups.clear()
    for (const material of this.materials) {
      material.destroy()
    }
    this.materials.clear()
    this.windows.clear()
    this.posterMaterials.clear()
    for (const fixture of this.posterLights) {
      fixture.removeComponent('light')
    }
    this.posterLights.clear()
    this.cloudMaterials.clear()
    this.groundMaterials.clear()
    this.posterTexture?.destroy()
    this.posterTexture = undefined
  }
}
