/** Native engine identity observations for the actual game-page lifecycle regression. */
import { AppBase, Entity, type MeshInstance, SHADER_FORWARD, Vec3 } from 'playcanvas'

const identities = new Map<string, string>()
export function rememberRider(id: string): string {
  const actor = AppBase.getApplication()?.root.findByTag(`rider:${id}`)[0]
  if (!(actor instanceof Entity)) {
    throw new Error(`Missing native rider${id}`)
  }
  const identity = actor.getGuid()
  identities.set(id, identity)
  return identity
}
export function sameRider(id: string): boolean {
  const actor = AppBase.getApplication()?.root.findByTag(`rider:${id}`)[0]
  return Boolean(actor instanceof Entity && actor.getGuid() === identities.get(id))
}

const FORWARD = 1 << SHADER_FORWARD
const DRAWN_MOUNT = /^mount\.Wrist[LR]\.drawn$/u
function controllers(root: Entity) {
  return root
    .findComponents('anim')
    .filter((component) => component.enabled && component.entity.enabled)
    .map((component) => ({
      node: component.entity.name,
      state: component.baseLayer?.activeState,
      time: component.baseLayer?.activeStateCurrentTime,
    }))
}
function instances(root: Entity): MeshInstance[] {
  return root.findComponents('render').flatMap((render) => render.meshInstances)
}
/** Physical rider, local arms and sight landmarks as the native renderer will draw them. */
export function firstPersonView(
  id: string,
  sight?: { front: number[]; rear: number[] },
): Record<string, unknown> {
  const app = AppBase.getApplication()
  const world = app?.root.findByTag(`rider:${id}`)[0]
  const arms = app?.root.findByTag(`viewmodel:${id}`) ?? []
  const camera = app?.root.findByName('camera')
  if (!(app && world instanceof Entity && camera instanceof Entity && camera.camera)) {
    throw new Error('Missing native first-person actors')
  }
  const visible = arms.filter((node): node is Entity => node instanceof Entity && node.enabled)
  const active = visible[0]
  const layer = app.scene.layers.getLayerByName('Viewmodel')
  const worldInstances = instances(world)
  const armInstances = active ? instances(active) : []
  const socket = active?.find((node) => node.name === 'socket.muzzle' && node.enabled)[0]
  const project = (point: number[] | undefined) => {
    if (!(socket && point)) {
      return
    }
    const anchor = socket.getWorldTransform().transformPoint(new Vec3(...point), new Vec3())
    const screen = camera.camera?.worldToScreen(anchor, new Vec3())
    return screen ? { x: screen.x, y: screen.y, z: screen.z } : undefined
  }
  const device = app.graphicsDevice
  return {
    eye: camera.getPosition().clone(),
    forward: camera.forward.clone(),
    fov: camera.camera.fov,
    screen: {
      width: device.width / device.maxPixelRatio,
      height: device.height / device.maxPixelRatio,
    },
    world: {
      enabled: world.enabled,
      root: world.getPosition().clone(),
      instances: worldInstances.length,
      forwardHidden: worldInstances.filter((instance) => !(instance.shaderPassMask & FORWARD))
        .length,
      castShadows: world.findComponents('render').filter((render) => render.castShadows).length,
      controllers: controllers(world),
    },
    arms: {
      total: arms.length,
      visible: visible.length,
      instances: armInstances.length,
      onLayer: active
        ? active
            .findComponents('render')
            .every((render) => layer && render.layers.length === 1 && render.layers[0] === layer.id)
        : false,
      castShadows:
        active?.findComponents('render').filter((render) => render.castShadows).length ?? 0,
      drawnGuns: active
        ? active.find((node) => DRAWN_MOUNT.test(node.name) && node.enabled).length
        : 0,
      muzzle: socket?.getPosition().clone(),
      front: project(sight?.front),
      rear: project(sight?.rear),
      controllers: active ? controllers(active) : [],
    },
    layer: layer
      ? {
          id: layer.id,
          clearDepth: layer.clearDepthBuffer,
          onCamera: camera.camera.layers.includes(layer.id),
        }
      : null,
    textures: device.textures.size,
    buffers: device.buffers.size,
    vram: { ...device._vram },
    assets: app.assets.list().length,
  }
}
