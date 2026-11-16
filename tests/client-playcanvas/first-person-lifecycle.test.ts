import { expect, test as it } from 'bun:test'
import { Entity, Quat, SHADER_FORWARD, SHADER_PREPASS, Vec3 } from 'playcanvas'
import {
  FirstPersonModel,
  type FirstPersonRequest,
} from '../../src/experiments/out-west/client/first-person-model.ts'
import { ViewmodelMotion } from '../../src/experiments/out-west/client/first-person-motion.ts'
import { RESTING_SIGHT } from '../../src/experiments/out-west/client/first-person-sights.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { newMotion } from '../../src/experiments/out-west/runtime/abilities.ts'
import { fitId } from '../../src/experiments/out-west/scene/native-equipment.ts'

/** Exercise the presentation lifecycle with real native transforms, without loading GPU assets. */
function fixture() {
  const model = Object.create(FirstPersonModel.prototype) as FirstPersonModel
  const rig = new Entity('rig')
  // AppBase normally activates its root; this GPU-free fixture supplies that hierarchy state.
  Reflect.set(rig, '_enabledInHierarchy', true)
  const world = new Entity('physical rider')
  const instances = [{ shaderPassMask: 0b1011, cull: true }]
  Reflect.set(world, 'findComponents', () => [{ meshInstances: instances }])
  const root = new Entity('arms')
  root.enabled = false
  rig.addChild(root)
  const skeleton = new Entity('skeleton')
  root.addChild(skeleton)
  const head = new Entity('Head')
  head.setLocalPosition(0, 1.6, 0)
  skeleton.addChild(head)
  const gun = new Entity('drawn gun')
  skeleton.addChild(gun)
  const socket = new Entity('socket.muzzle')
  gun.addChild(socket)
  const actor = Object.create(DuelActor.prototype) as DuelActor
  for (const [name, value] of Object.entries({
    root,
    model: skeleton,
    held: 'revolver',
    detached: new Map(),
    weaponMounts: [{ node: gun, drawn: true, hand: 'R' }],
  })) {
    Reflect.set(actor, name, value)
  }
  const request: FirstPersonRequest = {
    id: '0',
    world: { root: world } as DuelActor,
    domain: undefined,
    appearance: undefined,
    player: {
      id: '0',
      x: 2,
      y: 0.9,
      z: 3,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      grounded: true,
      hp: 100,
      ammo: 6,
      seq: 0,
      motion: newMotion(2, 0, 3),
    },
  }
  const current = {
    key: `${fitId(DEFAULT_LOADOUT)}:default`,
    url: 'arms.glb',
    actor,
    head,
    pose: { root: skeleton },
    firingUntil: 0,
  }
  const fields = {
    game: {
      app: { graphicsDevice: { width: 1280, height: 720 } },
      releaseContainer: () => undefined,
    },
    rig,
    layer: { dispose: () => undefined },
    current,
    desired: request,
    closed: false,
    masks: new Map(),
    urls: new Map([['arms.glb', 1]]),
    motion: new ViewmodelMotion(),
    sight: RESTING_SIGHT,
    sightPosition: new Vec3(),
    sightRotation: new Quat(),
    load: () => undefined,
  }
  for (const [key, value] of Object.entries(fields)) {
    Reflect.set(model, key, value)
  }
  const camera = new Entity('camera')
  camera.setPosition(2, 1.6, 3)
  return { model, rig, world, instances, actor, request, current, camera }
}

it('missing or failed arms keep the physical body visible', () => {
  const f = fixture()
  Reflect.set(f.model, 'current', undefined)
  f.model.update(f.request)
  expect(f.instances[0]?.shaderPassMask).toBe(0b1011)
  expect(f.model.stats().masked).toBe(0)
  expect(f.model.ready).toBe(false)
})

it('a replacement is hidden until its camera-relative transform is complete', () => {
  const f = fixture()
  expect(f.actor.root.enabled).toBe(false)
  expect(f.model.ready).toBe(false)
  f.model.present(f.camera, 1 / 60)
  expect(f.actor.root.enabled).toBe(true)
  expect(f.actor.root.getLocalPosition().length()).toBeGreaterThan(1)
  expect(f.rig.getPosition().equals(f.camera.getPosition())).toBe(true)
  expect(f.instances[0]?.shaderPassMask).toBe(
    0b1011 & ~((1 << SHADER_FORWARD) | (1 << SHADER_PREPASS)),
  )
  expect(f.model.ready).toBe(true)
})

it('appearance replacement restores world color and suppresses stale muzzle presentation', () => {
  const f = fixture()
  f.model.present(f.camera, 1 / 60)
  f.model.update({ ...f.request, appearance: { key: 'new', loadout: DEFAULT_LOADOUT, dyes: {} } })
  expect(f.actor.root.enabled).toBe(false)
  expect(f.instances[0]?.shaderPassMask).toBe(0b1011)
  expect(f.model.muzzle('0')).toBeNull()
  f.model.present(f.camera, 1 / 60)
  expect(f.actor.root.enabled).toBe(false)
})

it('late world attachments restore their exact masks on death and third-person transitions', () => {
  const f = fixture()
  f.model.present(f.camera, 1 / 60)
  f.instances.push({ shaderPassMask: 0b1101, cull: false })
  f.model.present(f.camera, 1 / 60)
  expect(f.model.stats().masked).toBe(2)
  f.model.update({ ...f.request, player: { ...f.request.player, hp: 0 } })
  expect(f.instances.map((instance) => instance.shaderPassMask)).toEqual([0b1011, 0b1101])
  expect(f.instances.map((instance) => instance.cull)).toEqual([true, false])
  expect(f.actor.root.enabled).toBe(false)
  f.model.update(undefined)
  expect(f.model.stats().masked).toBe(0)
})

it('missing weapon readiness and disposal cannot leave hidden world geometry', () => {
  const f = fixture()
  f.model.present(f.camera, 1 / 60)
  Reflect.set(f.actor, 'muzzleSocket', () => null)
  f.model.present(f.camera, 1 / 60)
  expect(f.actor.root.enabled).toBe(false)
  expect(f.instances[0]?.shaderPassMask).toBe(0b1011)
  f.model.destroy()
  f.model.present(f.camera, 1 / 60)
  expect(f.model.stats().arms).toBe(0)
  expect(f.model.stats().masked).toBe(0)
})

it('a paused frame retains an already presented actor and its exact world masks', () => {
  const f = fixture()
  f.model.present(f.camera, 1 / 60)
  const position = f.actor.root.getLocalPosition().clone()
  f.model.present(f.camera, 0)
  expect(f.actor.root.enabled).toBe(true)
  expect(f.actor.root.getLocalPosition().equals(position)).toBe(true)
  expect(f.model.stats().masked).toBe(1)
})
