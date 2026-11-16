import { expect, test as it } from 'bun:test'
import {
  AnimComponentSystem,
  AnimTrack,
  AppBase,
  AppOptions,
  Asset,
  type ContainerResource,
  Entity,
  NullGraphicsDevice,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'

it('restarting a one-shot during a blend preserves subsequent native transitions', async () => {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [AnimComponentSystem]
  app.init(options)
  const stage = new Entity('stage', app)
  app.root.addChild(stage)
  const animations = ['Idle', 'Gun_Shoot', 'Walk', 'Run'].map((name) => {
    const asset = new Asset(name, 'animation')
    asset.resource = new AnimTrack(name, name === 'Gun_Shoot' ? 0.2 : 1, [], [], [])
    return asset
  })
  const resource = {
    animations,
    materials: [],
    data: { gltf: {} },
    instantiateRenderEntity: () => new Entity('model', app),
  } as unknown as ContainerResource
  const asset = new Asset('restart fixture', 'container')
  asset.resource = resource
  const game = { app, stage, loadContainer: async () => asset } as unknown as GameApplication
  let actor: DuelActor | undefined
  try {
    actor = await DuelActor.create(game, '/fixture/restart.glb', 'restart test')
    const anim = actor.model.anim
    if (!anim?.baseLayer) {
      throw new Error('Missing native controller')
    }
    anim.update(0.2)
    actor.play('Gun_Shoot', 0.12)
    anim.update(0.04)
    actor.play('Gun_Shoot', 0)
    expect(() => actor?.play('Walk', 0.12)).not.toThrow()
    anim.update(0.2)
    expect(anim.baseLayer.activeState).toBe('Walk')
    actor.play('Gun_Shoot', 0)
    anim.update(0.5)
    actor.play('Gun_Shoot', 0)
    anim.update(0.05)
    expect(anim.baseLayer.activeStateCurrentTime).toBeCloseTo(0.05)
    expect(() => actor?.play('Run', 0)).not.toThrow()
  } finally {
    actor?.destroy()
    app.destroy()
    device.destroy()
  }
})
