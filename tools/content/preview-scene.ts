/** Asset inspection scene; run through the project's Vite dev server. */
import { Application, Asset, Color, Entity, Vec3 } from 'playcanvas'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'

export async function previewScene(
  name: 'frontier' | 'duel' | 'depot' | 'mission' | 'bank',
): Promise<void> {
  document.body.replaceChildren()
  document.body.style.margin = '0'
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  canvas.width = 1280
  canvas.height = 800
  const app = new Application(canvas, {})
  app.scene.ambientLight = new Color(0.7, 0.64, 0.53)
  const sun = new Entity('Sun')
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.88, 0.65),
    intensity: 1.7,
    castShadows: true,
    shadowDistance: 70,
    shadowResolution: 1024,
  })
  sun.setEulerAngles(50, 20, 0)
  app.root.addChild(sun)
  const camera = new Entity('Camera')
  camera.addComponent('camera', { clearColor: new Color(0.66, 0.77, 0.84), farClip: 600, fov: 55 })
  if (name === 'frontier') {
    camera.setPosition(93, 20, 93)
    camera.lookAt(new Vec3(72, 3, 66))
  } else {
    camera.setPosition(5, 2.5, 20)
    camera.lookAt(new Vec3(0, 2, -15))
  }
  app.root.addChild(camera)
  const spec = ASSETS[name]
  const asset = new Asset(name, 'container', { url: spec.url })
  await new Promise<void>((resolve, reject) => {
    asset.once('load', () => resolve())
    asset.once('error', (error: string) => reject(new Error(error)))
    app.assets.add(asset)
    app.assets.load(asset)
  })
  if (!asset.resource) {
    throw new Error('Container has no resource')
  }
  app.root.addChild(
    asset.resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true }),
  )
  app.start()
  Reflect.set(globalThis, 'contentPreviewReady', true)
}
