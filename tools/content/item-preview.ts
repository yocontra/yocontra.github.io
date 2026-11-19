/** Native asset studio used only by the offline catalogue image build. */

import type { ContainerResource } from 'playcanvas'
import { BoundingBox, Color, Entity, Vec3 } from 'playcanvas'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { prepareNativeMaterials } from '../../src/experiments/out-west/scene/native-materials.ts'
import { orientGunProduct } from './item-product-pose.ts'

const STUDIO_FOV = 36
const FRAME_FILL = 0.86

let game: GameApplication | null = null
let subject: Awaited<ReturnType<GameApplication['instantiate']>> | null = null
/** Fit all eight corners of the visible bounds in the square studio view. */
function framingDistance(bounds: BoundingBox, camera: Entity, direction: Vec3): number {
  const half = bounds.halfExtents
  const tangent = Math.tan((STUDIO_FOV * Math.PI) / 360) * FRAME_FILL
  let distance = 0
  const corner = new Vec3()
  const right = camera.right
  const up = camera.up
  for (const x of [-half.x, half.x]) {
    for (const y of [-half.y, half.y]) {
      for (const z of [-half.z, half.z]) {
        corner.set(x, y, z)
        const screen = Math.max(Math.abs(corner.dot(right)), Math.abs(corner.dot(up)))
        distance = Math.max(distance, corner.dot(direction) + screen / tangent)
      }
    }
  }
  return distance
}
async function createStudio(): Promise<GameApplication> {
  document.body.replaceChildren()
  document.body.style.margin = '0'
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  // Product shots stay the plain forward render: no vignette, dust or grade.
  const studio = await GameApplication.create({
    canvas,
    viewport: document.body,
    pixelRatio: 1,
    tier: 'low',
  })
  const camera = studio.camera.camera
  if (camera) {
    camera.fov = STUDIO_FOV
    camera.clearColor.set(0.315, 0.28, 0.23)
  }
  const key = studio.app.root.findByName('sun')
  if (key instanceof Entity && key.light) {
    key.light.color = new Color(1, 0.94, 0.86)
  }
  const fill = new Entity('Studio fill', studio.app)
  fill.addComponent('light', {
    type: 'directional',
    color: new Color(0.83, 0.9, 1),
    intensity: 0.72,
    castShadows: false,
  })
  fill.setEulerAngles(35, 48, 0)
  studio.app.root.addChild(fill)
  const skybox = studio.app.scene.layers?.getLayerByName('Skybox')
  if (skybox) {
    skybox.enabled = false
  }
  return studio
}
export async function previewItem(id: keyof typeof EQUIPMENT): Promise<void> {
  game ??= await createStudio()
  const studio = game
  subject?.destroy()
  const handlebar = id === 'extra.handlebar'
  const container = await studio.loadContainer(EQUIPMENT[id].url)
  const release = await prepareNativeMaterials(game, container.resource as ContainerResource)
  try {
    subject = await studio.instantiate(EQUIPMENT[id].url, id)
    subject.once('destroy', release)
  } catch (error) {
    release()
    throw error
  }
  for (const node of subject.find((candidate) => candidate.name.startsWith('mount.'))) {
    node.enabled = !(
      node.name.includes('holstered') ||
      (node.name.includes('WristL') && id !== 'gun.hardins-pair') ||
      node.name === 'FootL'
    )
  }
  if (id.startsWith('gun.')) {
    orientGunProduct(subject, id === 'gun.hardins-pair')
  }
  const outfit = id.startsWith('outfit.')
  const productYaw = handlebar ? 0 : -25
  subject.setEulerAngles(0, outfit ? -8 : productYaw, 0)
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const bounds = new BoundingBox()
  let first = true
  for (const render of subject.findComponents('render')) {
    if (!render.entity.enabled) {
      continue
    }
    for (const mesh of render.meshInstances) {
      if (first) {
        bounds.copy(mesh.aabb)
        first = false
      } else {
        bounds.add(mesh.aabb)
      }
    }
  }
  if (first) {
    throw new Error(`No visible native mesh for ${id}`)
  }
  const direction = new Vec3(handlebar ? 0 : 0.26, outfit ? 0.07 : 0.12, 1).normalize()
  studio.camera.setPosition(bounds.center.clone().add(direction))
  studio.camera.lookAt(bounds.center)
  const distance = framingDistance(bounds, studio.camera, direction)
  studio.camera.setPosition(bounds.center.clone().add(direction.clone().mulScalar(distance)))
  if (studio.camera.camera) {
    const radius = bounds.halfExtents.length()
    studio.camera.camera.nearClip = Math.max(0.001, distance - radius * 1.2)
    studio.camera.camera.farClip = distance + radius * 4
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}
