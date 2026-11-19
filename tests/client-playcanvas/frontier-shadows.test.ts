import { expect, test as it } from 'bun:test'
import { Entity, EventHandler, SHADOWUPDATE_NONE, SHADOWUPDATE_REALTIME } from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { FrontierShadows } from '../../src/experiments/out-west/client/frontier-shadows.ts'

it('the town sun keeps its shadow cadence with a nested sun and refreshes on fast turns', () => {
  const app = Object.assign(new EventHandler(), {
    root: new Entity('root'),
    scene: { layers: { getLayerByName: () => null } },
  })
  const camera = new Entity('camera')
  app.root.addChild(camera)
  const scenery = new Entity('scenery')
  const scenerySun = new Entity('sun')
  scenery.addChild(scenerySun)
  app.root.addChild(scenery)
  const sun = new Entity('sun')
  const light: { shadowUpdateMode: number } = { shadowUpdateMode: SHADOWUPDATE_REALTIME }
  Reflect.set(sun, 'light', light)
  app.root.addChild(sun)
  const game = { app, camera, quality: { fps: 30 } } as unknown as GameApplication
  const shadows = new FrontierShadows(game)
  try {
    app.fire('prerender')
    expect(light.shadowUpdateMode).toBe(SHADOWUPDATE_REALTIME)
    app.fire('prerender')
    expect(light.shadowUpdateMode).toBe(SHADOWUPDATE_NONE)
    app.fire('prerender')
    expect(light.shadowUpdateMode).toBe(SHADOWUPDATE_REALTIME)
    camera.setEulerAngles(0, 90, 0)
    app.fire('prerender')
    expect(light.shadowUpdateMode).toBe(SHADOWUPDATE_REALTIME)
  } finally {
    shadows.destroy()
  }
})
