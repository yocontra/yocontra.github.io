/** Unshipped native composition observations; no pointer or browser focus control. */
import { AppBase, Color, Entity, type MeshInstance, StandardMaterial, type Vec3 } from 'playcanvas'
import { FirstPersonModel } from '../../src/experiments/out-west/client/first-person-model.ts'
import {
  type HeldWeapon,
  SIGHTS,
} from '../../src/experiments/out-west/client/first-person-sights.ts'
import type { FrontierSession } from '../../src/experiments/out-west/client/frontier-session.ts'
import { poseEye } from '../../src/experiments/out-west/client/player-pose.ts'
import { CONTENT_VERSION } from '../../src/experiments/out-west/content/manifest.ts'
import { shotRay } from '../../src/experiments/out-west/ffa/sim/combat.ts'

const observation = { samples: 0, maximumRayChange: 0, maximumCameraShift: 0 }
let observing = false
export function activeFramingActor(): string | undefined {
  const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
  const actor = AppBase.getApplication()
    ?.root.findByTag(`viewmodel:${session.selfId}`)
    .find((node) => node.enabled)
  return actor instanceof Entity ? actor.getGuid() : undefined
}
export function observeFraming(): void {
  if (observing) {
    return
  }
  observing = true
  const present = FirstPersonModel.prototype.present
  FirstPersonModel.prototype.present = function (camera, dt) {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const player = session.world.players[session.selfSlot]
    if (!player) {
      present.call(this, camera, dt)
      return
    }
    // Both reads surround one synchronous native presentation call, never different ticks.
    const before = shotRay({ ...player }, player.aim)
    const eye = camera.getPosition().clone()
    present.call(this, camera, dt)
    const after = shotRay({ ...player }, player.aim)
    observation.samples++
    observation.maximumCameraShift = Math.max(
      observation.maximumCameraShift,
      eye.distance(camera.getPosition()),
    )
    for (const key of ['ox', 'oy', 'oz', 'dx', 'dy', 'dz'] as const) {
      observation.maximumRayChange = Math.max(
        observation.maximumRayChange,
        Math.abs(before[key] - after[key]),
      )
    }
  }
}

function assertFinishMaps(instances: MeshInstance[], weapon: HeldWeapon): void {
  const heldMesh = instances.find(
    (instance) =>
      instance.node.enabled && !instance.skinInstance && instance.material?.name === 'Gun',
  )
  const finish = heldMesh?.material
  if (
    !(
      finish instanceof StandardMaterial &&
      finish.diffuseMap &&
      finish.normalMap &&
      finish.glossMap
    )
  ) {
    throw new Error(`Missing native ${weapon} finish maps`)
  }
}

export function captureFraming(weapon: HeldWeapon, identifyParts = false) {
  if (
    observation.samples === 0 ||
    observation.maximumRayChange > 1e-9 ||
    observation.maximumCameraShift > 1e-9
  ) {
    throw new Error(
      `Native presentation changed the physical eye or shot ray: ${JSON.stringify(observation)}`,
    )
  }
  const app = AppBase.getApplication()
  const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
  const camera = app?.root.findByName('camera')
  const actor = app?.root.findByTag(`viewmodel:${session.selfId}`).find((node) => node.enabled)
  const layer = app?.scene.layers.getLayerByName('Viewmodel')
  const domain = session.world.players[session.selfSlot]
  const player = session.players.get(session.selfId)
  const profile = SIGHTS.get(weapon)
  if (
    !(
      app &&
      camera instanceof Entity &&
      camera.camera &&
      actor instanceof Entity &&
      layer &&
      domain &&
      player &&
      profile
    )
  ) {
    throw new Error('Native framing actors are not ready')
  }
  const canvas = app.graphicsDevice.canvas as HTMLCanvasElement
  const lens = camera.camera
  const renders = actor.findComponents('render')
  const instances = renders.flatMap((render) => render.meshInstances)
  const socket = actor.find((node) => node.name === 'socket.muzzle' && node.enabled)[0]
  const actors = app.root.findByTag(`viewmodel:${session.selfId}`)
  if (
    !socket ||
    actors.length !== 1 ||
    instances.length === 0 ||
    renders.some((render) => render.layers.length !== 1 || render.layers[0] !== layer.id)
  ) {
    throw new Error('Expected one loaded native arms actor on the Viewmodel layer')
  }
  assertFinishMaps(instances, weapon)
  const project = (landmark: Vec3) =>
    lens.worldToScreen(socket.getWorldTransform().transformPoint(landmark))
  const view = {
    eye: camera.getPosition().clone(),
    fov: lens.fov,
    arms: { front: project(profile.front), rear: project(profile.rear) },
  }
  app.render()
  const image = canvas.toDataURL('image/png')
  const layers = [...lens.layers]
  const clear = lens.clearColor.clone()
  const materials = instances.map((instance) => instance.material)
  const inverseCamera = camera.getWorldTransform().clone().invert()
  const colors = [
    [1, 0.1, 0.1],
    [0.1, 1, 0.1],
    [0.1, 0.3, 1],
    [1, 1, 0.1],
    [1, 0.1, 1],
    [0.1, 1, 1],
    [1, 0.5, 0.1],
  ] as const
  const geometry = instances.map((instance, index) => {
    const { center, halfExtents } = instance.aabb
    const depth = -inverseCamera.transformPoint(center).z
    const rotation = inverseCamera.data
    const extent =
      Math.abs(rotation[2] ?? 0) * halfExtents.x +
      Math.abs(rotation[6] ?? 0) * halfExtents.y +
      Math.abs(rotation[10] ?? 0) * halfExtents.z
    return {
      index,
      color: colors[index % colors.length],
      node: instance.node.getPath(),
      material: instance.material?.name,
      visible: instance.visible && instance.node.enabled,
      skinned: Boolean(instance.skinInstance),
      boundsDepth: {
        nearest: depth - extent,
        farthest: depth + extent,
        cameraNear: lens.nearClip,
      },
    }
  })
  const flat = new StandardMaterial()
  flat.useLighting = false
  flat.diffuse.set(0, 0, 0)
  flat.emissive.set(1, 1, 1)
  flat.update()
  let mask: string
  let parts: string | undefined
  const partMaterials: StandardMaterial[] = []
  try {
    lens.layers = [layer.id]
    lens.clearColor = new Color(0, 0, 0, 1)
    for (const instance of instances) {
      instance.material = flat
    }
    app.render()
    mask = canvas.toDataURL('image/png')
    if (identifyParts) {
      for (const [index, instance] of instances.entries()) {
        const material = new StandardMaterial()
        const color = colors[index % colors.length]
        if (!color) {
          throw new Error('Missing native part color')
        }
        material.useLighting = false
        material.diffuse.set(0, 0, 0)
        material.emissive.set(color[0], color[1], color[2])
        material.update()
        partMaterials.push(material)
        instance.material = material
      }
      app.render()
      parts = canvas.toDataURL('image/png')
    }
  } finally {
    for (const [index, instance] of instances.entries()) {
      const material = materials[index]
      if (material) {
        instance.material = material
      }
    }
    lens.layers = layers
    lens.clearColor = clear
    flat.destroy()
    for (const material of partMaterials) {
      material.destroy()
    }
    app.render()
  }
  if (
    lens.layers.join(',') !== layers.join(',') ||
    !lens.clearColor.equals(clear) ||
    instances.some((instance, index) => instance.material !== materials[index])
  ) {
    throw new Error('Native mask capture did not restore the scene')
  }
  return {
    contentVersion: CONTENT_VERSION,
    actor: actor.getGuid(),
    profile: { relief: profile.relief, zoom: profile.zoom },
    stance: { crouched: domain.crouched, aimed: domain.ads, weapon: domain.weapon },
    view,
    physicalEye: poseEye(player),
    ray: shotRay(domain, domain.aim),
    observation: { ...observation },
    image,
    mask,
    parts,
    geometry,
  }
}
