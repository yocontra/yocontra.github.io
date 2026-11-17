/** Depth-isolated native arms layer sharing current and subsequently created world lights. */
import { type Entity, Layer, type LightComponent } from 'playcanvas'
import type { GameApplication } from './application.ts'

export function viewmodelLayer(game: GameApplication): { layer: Layer; dispose: () => void } {
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
    layer,
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
