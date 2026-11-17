/** Depth-isolated native arms layer sharing current and subsequently created world lights. */
import { type Entity, Layer, type LightComponent, StandardMaterial } from 'playcanvas'
import type { GameApplication } from './application.ts'

export function viewmodelLayer(game: GameApplication): {
  assign: (root: Entity) => void
  dispose: () => void
} {
  const layers = game.app.scene.layers
  const world = layers.getLayerByName('World')
  if (!world) {
    throw new Error('Missing native World layer')
  }
  const layer = new Layer({ name: 'Viewmodel', clearDepthBuffer: true })
  const index = layers.getTransparentIndex(world)
  layers.insertOpaque(layer, index + 1)
  layers.insertTransparent(layer, index + 2)
  const camera = game.camera.camera
  if (camera) {
    camera.layers = [...camera.layers, layer.id]
  }
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
        if (!game.post) {
          continue
        }
        for (const mesh of render.meshInstances) {
          const source = mesh.material
          if (!(source instanceof StandardMaterial)) {
            continue
          }
          let material = materials.get(source)
          if (!material) {
            material = source.clone()
            // The World's depth prepass doesn't contain arms. Sampling its SSAO would
            // project world silhouettes onto the weapon and sleeves. Keep authored PBR AO.
            material.onUpdateShader = (options) => {
              options.litOptions.ssao = false
              return options
            }
            materials.set(source, material)
          }
          mesh.material = material
        }
      }
    },
    dispose() {
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
