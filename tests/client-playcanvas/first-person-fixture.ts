/** Native actor/equipment/controller path with deferred in-memory asset delivery. */
import {
  AnimComponentSystem,
  AnimTrack,
  AppBase,
  AppOptions,
  Asset,
  BatchManager,
  CameraComponentSystem,
  type ContainerResource,
  Entity,
  LightComponentSystem,
  NullGraphicsDevice,
  RenderComponentSystem,
  StandardMaterial,
  Texture,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import {
  FirstPersonModel,
  type FirstPersonRequest,
} from '../../src/experiments/out-west/client/first-person-model.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { newMotion } from '../../src/experiments/out-west/runtime/abilities.ts'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const CLIPS = [
  'Idle',
  'Idle_Gun_Pointing',
  'Idle_Gun_Pointing_Pair',
  'Gun_Shoot',
  'Gun_Shoot_Pair',
  'Walk',
  'Run',
  'Sprint',
  'Jump_Loop',
  'Crouch_Idle',
  'Crouch_Walk',
  'Reload',
  'Crouch_Reload',
  'Crouch_Idle_Gun_Pointing',
  'Crouch_Gun_Shoot',
  'Throw_Dynamite',
  'Crouch_Throw_Dynamite',
  'Aim_Up',
  'Aim_Down',
  'Crouch_Aim_Up',
  'Crouch_Aim_Down',
  'Hold_rifle',
  'Hold_shotgun',
  'Shoot_rifle',
  'Shoot_shotgun',
  'Crouch_Hold_rifle',
  'Crouch_Hold_shotgun',
  'Crouch_Shoot_rifle',
  'Crouch_Shoot_shotgun',
]

const LONG_GUN_ACTION = /(?:Hold|Shoot)_(?:rifle|shotgun)$/u

function clipSeconds(name: string): number {
  if (name.endsWith('Throw_Dynamite')) {
    return 0.7
  }
  return name.includes('Shoot') ? 0.2 : 1
}

function fixtureAsset(
  app: AppBase,
  url: string,
  registry: { materials: StandardMaterial[]; created: Entity[] },
): Asset {
  const body = url.includes('/viewmodels/') || url.includes('/equipment/outfit.')
  const long = ['rifle', 'shotgun'].find((weapon) => url.includes(`held-${weapon}`))
  const hands = url.includes('hardins') ? ['R', 'L'] : ['R']
  const mechanisms = long ? [long] : hands
  const mounts = long ? ['mount.Chest.long'] : hands.map((hand) => `mount.Wrist${hand}.drawn`)
  const material = new StandardMaterial()
  material.name = 'fixture cloth and steel'
  registry.materials.push(material)
  const materialAsset = new Asset('fixture material', 'material')
  materialAsset.resource = material
  const character = body || url.includes('moves')
  const arms = url.includes('viewmodel-arm-curves')
  const clips =
    character || arms
      ? CLIPS.filter((name) => character || LONG_GUN_ACTION.test(name))
      : mechanisms.flatMap((hand) =>
          ['Idle', 'Shoot', 'Reload', 'Draw'].map((action) => `Weapon_${action}_${hand}`),
        )
  const animations = clips.map((name, index) => {
    const asset = new Asset(`fixture/animation/${index}`, 'animation')
    asset.resource = new AnimTrack(name, clipSeconds(name), [], [], [])
    return asset
  })
  const value = {
    animations,
    materials: [materialAsset],
    data: {
      gltf: { materials: [{ extras: { nativePbr: { albedo: 'fixture://shared-albedo' } } }] },
    },
    instantiateRenderEntity() {
      const root = new Entity(body ? 'skeleton' : 'prop', app)
      registry.created.push(root)
      if (body) {
        for (const name of [
          'Root',
          'Hips',
          'Abdomen',
          'Torso',
          'Chest',
          'Head',
          'WristR',
          'WristL',
        ]) {
          const node = new Entity(name, app)
          root.addChild(node)
          if (name === 'Head') {
            node.setLocalPosition(0, 1.6, 0)
          }
        }
        root.addComponent('render', { type: 'box', material, castShadows: true })
      } else {
        for (const name of mounts) {
          const mount = new Entity(name, app)
          root.addChild(mount)
          mount.addComponent('render', { type: 'box', material, castShadows: true })
          mount.addChild(new Entity('socket.muzzle', app))
        }
      }
      return root
    },
  } as unknown as ContainerResource
  const asset = new Asset(url, 'container')
  asset.resource = value
  return asset
}

export function firstPersonFixture(batches = false) {
  const device = new NullGraphicsDevice({ width: 1280, height: 720 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [
    AnimComponentSystem,
    CameraComponentSystem,
    LightComponentSystem,
    RenderComponentSystem,
  ]
  if (batches) {
    options.batchManager = BatchManager
  }
  app.init(options)
  const stage = new Entity('stage', app)
  app.root.addChild(stage)
  const camera = new Entity('camera', app)
  app.root.addChild(camera)
  camera.addComponent('camera', { fov: 70 })
  camera.setPosition(2, 1.6, 3)
  const world = new Entity('physical rider', app)
  stage.addChild(world)
  world.addComponent('render', { type: 'box', castShadows: true })
  const released: string[] = []
  const textureLoads: string[] = []
  const textureReleases: string[] = []
  const textures = new Map<string, Texture>()
  const textureInstances: Texture[] = []
  const materials: StandardMaterial[] = []
  const cached = new Map<string, Asset>()
  const requests: { url: string; done: ReturnType<typeof deferred<Asset>>; finish: () => void }[] =
    []
  const created: Entity[] = []
  let delayTextures = false
  const texturePending: {
    url: string
    done: ReturnType<typeof deferred<Asset>>
    finish: () => void
  }[] = []

  const resource = (url: string): Asset => {
    const asset = cached.get(url) ?? fixtureAsset(app, url, { materials, created })
    cached.set(url, asset)
    return asset
  }
  const texture = (url: string): Asset => {
    const value = new Texture(device, { width: 1, height: 1 })
    textureInstances.push(value)
    textures.set(url, value)
    const asset = new Asset(url, 'texture')
    asset.resource = value
    return asset
  }
  const game = {
    app,
    stage,
    camera,
    loadContainer(url: string) {
      if (url.includes('/viewmodels/') || url.includes('/held-')) {
        const done = deferred<Asset>()
        requests.push({ url, done, finish: () => done.resolve(resource(url)) })
        return done.promise
      }
      return Promise.resolve(resource(url))
    },
    releaseContainer: (url: string) => {
      released.push(url)
    },
    loadTexture(url: string) {
      textureLoads.push(url)
      if (delayTextures) {
        const done = deferred<Asset>()
        texturePending.push({ url, done, finish: () => done.resolve(texture(url)) })
        return done.promise
      }
      return Promise.resolve(texture(url))
    },
    releaseTexture(url: string) {
      textureReleases.push(url)
      textures.get(url)?.destroy()
      textures.delete(url)
    },
  } as unknown as GameApplication
  const model = new FirstPersonModel(game)
  const request: FirstPersonRequest = {
    id: 'self',
    world: {
      root: world,
      tracks: CLIPS.map((name) => new AnimTrack(name, clipSeconds(name), [], [], [])),
    } as unknown as DuelActor,
    domain: undefined,
    appearance: undefined,
    player: {
      id: 'self',
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
  const appearance = (key: string): FirstPersonRequest => ({
    ...request,
    appearance: { key, loadout: DEFAULT_LOADOUT, dyes: {} },
  })
  return {
    app,
    game,
    model,
    camera,
    world,
    request,
    appearance,
    requests,
    created,
    released,
    textureLoads,
    textureReleases,
    textures,
    texturePending,
    textureInstances,
    delayTextures() {
      delayTextures = true
    },
    actors: () => app.root.find((node) => node.name === 'viewmodel') as Entity[],
    async finish(index = 0) {
      requests[index]?.finish()
      await flush()
      for (const pending of requests.slice(index + 1)) {
        pending.finish()
      }
      await flush()
    },
    dispose() {
      model.destroy()
      app.destroy()
      for (const material of materials) {
        material.destroy()
      }
    },
  }
}
