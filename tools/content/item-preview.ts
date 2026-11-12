/** Native asset studio used only by the offline catalogue image build. */

import type { ContainerResource } from 'playcanvas'
import { BoundingBox, Vec3 } from 'playcanvas'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { prepareNativeMaterials } from '../../src/experiments/out-west/scene/native-materials.ts'

let game: GameApplication | null = null
let subject: Awaited<ReturnType<GameApplication['instantiate']>> | null = null
export async function previewItem(id: keyof typeof EQUIPMENT): Promise<void> {
  if (!game) {
    document.body.replaceChildren()
    document.body.style.margin = '0'
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    // Product shots stay the plain forward render: no vignette, dust or grade.
    game = await GameApplication.create({
      canvas,
      viewport: document.body,
      pixelRatio: 1,
      tier: 'low',
    })
    game.camera.camera?.clearColor.set(0.24, 0.2, 0.16)
    const skybox = game.app.scene.layers?.getLayerByName('Skybox')
    if (skybox) {
      skybox.enabled = false
    }
  }
  subject?.destroy()
  const container = await game.loadContainer(EQUIPMENT[id].url)
  const release = await prepareNativeMaterials(game, container.resource as ContainerResource)
  try {
    subject = await game.instantiate(EQUIPMENT[id].url, id)
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
  subject.setEulerAngles(0, -25, id.startsWith('gun.') ? 90 : 0)
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
  const radius = bounds.halfExtents.length()
  const distance = (radius / Math.sin((29 * Math.PI) / 180)) * 1.15
  game.camera.setPosition(
    bounds.center.clone().add(new Vec3(distance * 0.35, distance * 0.12, distance)),
  )
  game.camera.lookAt(bounds.center)
  if (game.camera.camera) {
    game.camera.camera.nearClip = 0.01
    game.camera.camera.farClip = distance + radius * 4
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}
