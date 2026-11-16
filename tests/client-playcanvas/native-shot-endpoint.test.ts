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
import { animateRider } from '../../src/experiments/out-west/client/actor-animation.ts'
import { createRiderPose } from '../../src/experiments/out-west/client/actor-pose.ts'
import { Actors } from '../../src/experiments/out-west/client/actors.ts'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import type { PlayerState } from '../../src/experiments/out-west/runtime/protocol.ts'

it('finishes the native 200 ms first-person shot and cancels it on a life or view reset', async () => {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [AnimComponentSystem]
  app.init(options)
  const stage = new Entity('stage', app)
  app.root.addChild(stage)
  const animations = ['Idle', 'Gun_Shoot', 'Idle_Gun_Pointing', 'Death'].map((name) => {
    const asset = new Asset(name, 'animation')
    asset.resource = new AnimTrack(name, name === 'Gun_Shoot' ? 0.6 : 1, [], [], [])
    return asset
  })
  const resource = {
    animations,
    materials: [],
    data: { gltf: {} },
    instantiateRenderEntity: () => new Entity('model', app),
  } as unknown as ContainerResource
  const asset = new Asset('shot clock fixture', 'container')
  asset.resource = resource
  const game = { app, stage, loadContainer: async () => asset } as unknown as GameApplication
  let actor: DuelActor | undefined
  try {
    actor = await DuelActor.create(game, '/equipment/outfit.fixture.glb', 'shot test')
    const pose = createRiderPose(game, actor)
    const player: PlayerState = {
      id: 'self',
      x: 0,
      y: 0.9,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      grounded: true,
      hp: 100,
      ammo: 6,
      seq: 0,
    }
    const rider = {
      actor,
      pose,
      clip: '',
      aim: pose.aim,
      weaponLayer: pose.weapon,
      firingUntil: performance.now() - 1,
    }
    const host = {
      actors: new Map([['self', rider]]),
      players: new Map([['self', player]]),
      firstPerson: { fire: () => undefined },
    } as unknown as Actors
    const fire = () => Actors.prototype.fire.call(host, 'self')
    fire()
    rider.firingUntil = performance.now() - 1
    app.systems.fire('animationUpdate', 0.1999)
    expect(pose.weapon.activeStateCurrentTime).toBeCloseTo(0.5997, 6)
    animateRider(rider, player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Gun_Shoot')
    app.systems.fire('animationUpdate', 0.0002)
    expect(pose.weapon.activeStateCurrentTime).toBeGreaterThanOrEqual(
      pose.weapon.activeStateDuration,
    )
    animateRider(rider, player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Idle_Gun_Pointing')
    expect(fire).not.toThrow()
    rider.firingUntil = performance.now() + 200
    animateRider(rider, { ...player, hp: 0 }, { first: true, domain: undefined })
    expect(rider.firingUntil).toBe(0)
    expect(pose.weapon.activeState).toBe('Idle_Gun_Pointing')
    for (const first of [true, false]) {
      expect(fire).not.toThrow()
      app.systems.fire('animationUpdate', 0.01)
      rider.firingUntil = first ? 0 : performance.now() - 1
      animateRider(rider, player, { first, domain: undefined })
      expect(pose.weapon.activeState).toBe('Idle_Gun_Pointing')
    }
  } finally {
    actor?.destroy()
    app.destroy()
    device.destroy()
  }
})
