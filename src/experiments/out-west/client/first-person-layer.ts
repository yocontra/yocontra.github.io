/** Depth-isolated native arms layer sharing current and subsequently created world lights. */
import { Color, Entity, Layer, type LightComponent, StandardMaterial } from 'playcanvas'
import type { GameApplication } from './application.ts'

function viewmodelMaterial(source: StandardMaterial, post: boolean): StandardMaterial {
  const material = source.clone()
  if (source.name === 'Gun' && source.normalMap) {
    material.bumpiness = source.bumpiness * 1.25
  }
  if (post) {
    // World SSAO would project scenery silhouettes onto the arms.
    material.onUpdateShader = (options) => {
      options.litOptions.ssao = false
      return options
    }
  }
  material.update()
  return material
}

export function viewmodelLayer(game: GameApplication): {
  assign: (root: Entity) => void
  setVisible: (visible: boolean) => void
  dispose: () => void
} {
  const layers = game.app.scene.layers
  const world = layers.getLayerByName('World')
  if (!world) {
    throw new Error('Missing native World layer')
  }
  const layer = new Layer({ name: 'Viewmodel', enabled: false, clearDepthBuffer: true })
  const index = layers.getTransparentIndex(world)
  layers.insertOpaque(layer, index + 1)
  layers.insertTransparent(layer, index + 2)
  const camera = game.camera.camera
  if (camera) {
    camera.layers = [...camera.layers, layer.id]
  }
  // Keep walnut grain and blued steel readable when the world key is behind the rider.
  const fill = new Entity('viewmodel fill', game.app)
  fill.enabled = false
  fill.setLocalEulerAngles(65, -24, 12)
  fill.addComponent('light', {
    type: 'directional',
    color: new Color(0.85, 0.91, 1),
    intensity: 0.65,
    castShadows: false,
    layers: [layer.id],
  })
  game.camera.addChild(fill)
  const lights = new Set<LightComponent>()
  const include = (_entity: Entity, light: LightComponent) => {
    if (light.layers.includes(world.id) && !lights.has(light)) {
      lights.add(light)
      light.layers = [...light.layers, layer.id]
    }
  }
  const forget = (_entity: Entity, light: LightComponent) => lights.delete(light)
  const system = game.app.systems.light
  system?.on('add', include)
  system?.on('beforeremove', forget)
  for (const light of game.app.root.findComponents('light')) {
    include(light.entity, light)
  }
  return {
    assign(root) {
      const materials = new Map<StandardMaterial, StandardMaterial>()
      root.once('destroy', () => {
        for (const material of materials.values()) {
          material.destroy()
        }
      })
      for (const render of root.findComponents('render')) {
        render.castShadows = false
        render.layers = [layer.id]
        for (const mesh of render.meshInstances) {
          const source = mesh.material
          if (!(source instanceof StandardMaterial && (game.post || source.name === 'Gun'))) {
            continue
          }
          let material = materials.get(source)
          if (!material) {
            material = viewmodelMaterial(source, Boolean(game.post))
            materials.set(source, material)
          }
          mesh.material = material
        }
      }
    },
    setVisible(visible) {
      layer.enabled = visible
      fill.enabled = visible
    },
    dispose() {
      fill.destroy()
      system?.off('add', include)
      system?.off('beforeremove', forget)
      for (const light of lights) {
        light.layers = light.layers.filter((id) => id !== layer.id)
      }
      lights.clear()
      if (camera) {
        camera.layers = camera.layers.filter((id) => id !== layer.id)
      }
      layers.removeOpaque(layer)
      layers.removeTransparent(layer)
    },
  }
}
