import { beforeAll, expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  AnimComponentSystem,
  type AnimTrack,
  AppBase,
  AppOptions,
  Asset,
  ContainerHandler,
  type ContainerResource,
  Entity,
  NullGraphicsDevice,
  PIXELFORMAT_RGBA8,
  RenderComponentSystem,
  Texture,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { AMBIENT_ASSETS } from '../../src/experiments/out-west/content/ambient.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { extractFirstPersonArms } from '../../tools/content/first-person-arms.ts'

const FIT = 'outfit.trail-duds'
const PHYSICAL = `/experiments/out-west/3d/native-v2/equipment/${FIT}.glb`
const ARMS = '/fixtures/viewmodels/geometry-only.glb'
const POSE_BONES = /^(?:Root|Hips|Abdomen|Torso|Chest|Head|UpperArm[LR]|LowerArm[LR]|Wrist[LR])$/u
let armsBytes: Uint8Array
beforeAll(async () => {
  armsBytes = (await extractFirstPersonArms(FIT, { geometryOnly: true })).bytes
}, 30_000)

function fixture() {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem, AnimComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  app.init(options)
  const stage = new Entity('stage', app)
  app.root.addChild(stage)
  const assets = new Map<string, Promise<Asset>>()
  const textures = new Map<string, Texture>()
  const requests: string[] = []
  const load = async (url: string) => {
    const contents = url === ARMS ? armsBytes : await readFile(`public${url.split('?')[0]}`)
    const asset = new Asset(url, 'container', {
      url,
      contents: new Uint8Array(contents).buffer,
    })
    app.assets.add(asset)
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve())
      asset.once('error', reject)
      app.assets.load(asset)
    })
    return asset
  }
  const game = {
    app,
    stage,
    loadContainer(url: string) {
      requests.push(url)
      let pending = assets.get(url)
      if (!pending) {
        pending = load(url)
        assets.set(url, pending)
      }
      return pending
    },
    loadTexture(url: string) {
      let texture = textures.get(url)
      if (!texture) {
        texture = new Texture(device, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 })
        textures.set(url, texture)
      }
      const asset = new Asset(url, 'texture')
      asset.resource = texture
      return Promise.resolve(asset)
    },
    releaseTexture(url: string) {
      textures.get(url)?.destroy()
      textures.delete(url)
    },
  } as unknown as GameApplication
  return {
    game,
    app,
    stage,
    requests,
    assets,
    textures,
    async destroy() {
      stage.destroy()
      const loaded = await Promise.all(assets.values())
      for (const asset of loaded) {
        asset.unload()
        app.assets.remove(asset)
      }
      for (const texture of textures.values()) {
        texture.destroy()
      }
      app.destroy()
      return { textures: device.textures.size, buffers: device.buffers.size }
    },
  }
}

function anim(actor: DuelActor) {
  const component = actor.model.anim
  if (!component?.baseLayer) {
    throw new Error('Actual native animation graph missing')
  }
  return component
}
function resource(asset: Asset): ContainerResource {
  return asset.resource as ContainerResource
}
function track(asset: Asset, name: string): AnimTrack {
  const result = resource(asset).animations.find((entry) => entry.resource?.name === name)?.resource
  if (!result) {
    throw new Error(`Missing authored ${name}`)
  }
  return result as AnimTrack
}

function keyframes(tracks: readonly AnimTrack[]): string {
  return JSON.stringify(
    tracks.map((entry) => ({
      name: entry.name,
      duration: entry.duration,
      inputs: entry.inputs.map((data) => [data.components, Array.from(data.data)]),
      outputs: entry.outputs.map((data) => [data.components, Array.from(data.data)]),
      paths: entry.curves.map((curve) => curve.paths),
    })),
  )
}

it('real clip-free arms reuse physical merged tracks before native graph/index/mask construction', async () => {
  const f = fixture()
  let physical: DuelActor | undefined
  let arms: DuelActor | undefined
  try {
    physical = await DuelActor.create(f.game, PHYSICAL, 'physical')
    const native = await f.game.loadContainer(PHYSICAL)
    const moves = await f.game.loadContainer(ASSETS.moves.url)
    expect(physical.tracks).toHaveLength(83)
    expect(physical.animationTrack('Gun_Shoot')).toBe(track(native, 'Gun_Shoot'))
    expect(physical.animationTrack('Gun_Shoot')).not.toBe(track(moves, 'Gun_Shoot'))
    const before = keyframes(physical.tracks)
    arms = await DuelActor.create(f.game, ARMS, 'arms', {
      enabled: false,
      tracks: physical.tracks,
      humanoid: true,
    })
    expect(resource(await f.game.loadContainer(ARMS)).animations).toHaveLength(0)
    expect(arms.root.enabled).toBe(false)
    expect(arms.tracks).not.toBe(physical.tracks)
    expect(arms.tracks).toHaveLength(83)
    for (const [index, entry] of arms.tracks.entries()) {
      expect(physical.tracks[index]).toBe(entry)
      expect(arms.animationTrack(entry.name)).toBe(entry)
      expect(anim(arms).baseLayer?.states).toContain(entry.name)
    }
    expect(arms.upperBodyMask()).toEqual(physical.upperBodyMask())
    expect(arms.gaitSpeeds).toEqual(physical.gaitSpeeds)
    arms.root.enabled = true
    const body = anim(physical)
    const view = anim(arms)
    const joints = physical.model.findByName('WristR')?.parent
    expect(joints).toBeTruthy()
    const positions = (actor: DuelActor) =>
      actor.model
        .find(() => true)
        .filter((node) => POSE_BONES.test(node.name))
        .map((node) => [node.name, Array.from(node.getLocalTransform().data)])
    for (const entry of physical.tracks) {
      body.baseLayer?.play(entry.name)
      view.baseLayer?.play(entry.name)
      body.update(0.037)
      view.update(0.037)
      expect(positions(arms)).toEqual(positions(physical))
    }
    physical.play('Walk', 0)
    arms.play('Walk', 0)
    physical.play('Gun_Shoot', 0)
    arms.play('Gun_Shoot', 0)
    body.update(0.05)
    const physicalTime = body.baseLayer?.activeStateCurrentTime
    const frozenPhysicalPose = positions(physical)
    view.update(0.199)
    const shotDuration = arms.animationTrack('Gun_Shoot')?.duration
    if (shotDuration === undefined) {
      throw new Error('Missing real shoot track')
    }
    // Native controller time is in track seconds. Its progress getter re-applies clip speed.
    expect(view.baseLayer?.activeStateCurrentTime).toBeCloseTo(shotDuration * 0.995)
    expect(view.baseLayer?.activeStateCurrentTime).toBeLessThan(shotDuration)
    expect(body.baseLayer?.activeStateCurrentTime).toBe(physicalTime)
    expect(positions(physical)).toEqual(frozenPhysicalPose)
    view.update(0.002)
    expect(view.baseLayer?.activeStateCurrentTime).toBeCloseTo(shotDuration)
    expect(keyframes(physical.tracks)).toBe(before)
    arms.destroy()
    arms = undefined
    physical.play('Walk', 0)
    expect(() => body.update(0.1)).not.toThrow()
    expect(f.textures.size).toBeGreaterThan(0)
  } finally {
    arms?.destroy()
    physical?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('an explicit humanoid builds native shared animation on an empty-clip geometry URL', async () => {
  const f = fixture()
  let actor: DuelActor | undefined
  try {
    actor = await DuelActor.create(f.game, ARMS, 'shared-only humanoid', {
      enabled: true,
      humanoid: true,
    })
    expect(actor.tracks).toHaveLength(73)
    expect(actor.hasAnimation('Idle_Character')).toBe(true)
    expect(actor.hasAnimation('Gun_Shoot')).toBe(true)
    actor.play('Gun_Shoot', 0)
    anim(actor).update(0.201)
    expect(anim(actor).baseLayer?.activeStateCurrentTime).toBeCloseTo(
      actor.animationTrack('Gun_Shoot')?.duration ?? 0,
    )
  } finally {
    actor?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('default native animals retain their source clips and one-second playback rate', async () => {
  const f = fixture()
  let crow: DuelActor | undefined
  try {
    crow = await DuelActor.create(f.game, AMBIENT_ASSETS.crow.url, 'crow')
    expect(crow.tracks).toHaveLength(3)
    expect(f.requests).not.toContain(ASSETS.moves.url)
    crow.play('Gun_Shoot', 0)
    anim(crow).update(0.1)
    expect(anim(crow).baseLayer?.activeStateCurrentTime).toBeCloseTo(0.1)
    expect(anim(crow).baseLayer?.activeStateProgress).toBeLessThan(0.1)
  } finally {
    crow?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('removed stage rejects arms creation without adopting late native resources', async () => {
  const f = fixture()
  try {
    const physical = await DuelActor.create(f.game, PHYSICAL, 'physical')
    const tracks = physical.tracks
    physical.destroy()
    f.stage.remove()
    const result = await DuelActor.create(f.game, ARMS, 'cancelled arms', {
      enabled: false,
      tracks,
      humanoid: true,
    }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(DOMException)
    expect(f.stage.children).toHaveLength(0)
    expect(f.textures.size).toBe(0)
  } finally {
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('paired local carry and disabled socket inspection use native authored mount state', async () => {
  const f = fixture()
  let actor: DuelActor | undefined
  try {
    const physical = await DuelActor.create(f.game, PHYSICAL, 'physical')
    actor = await DuelActor.create(f.game, ARMS, 'disabled presentation', {
      enabled: false,
      tracks: physical.tracks,
      humanoid: true,
    })
    physical.destroy()
    const mount = (hand: 'L' | 'R', weapon?: 'rifle') => {
      const node = new Entity(`mount.${weapon ?? hand}`, f.app)
      const socket = new Entity('socket.muzzle', f.app)
      const wrist = actor?.model.findByName(`Wrist${hand}`)
      if (!(wrist instanceof Entity)) {
        throw new Error('Missing actual authored wrist')
      }
      wrist.addChild(node)
      node.addChild(socket)
      socket.setLocalPosition(0.12, 0.01, 0)
      actor?.weaponMounts.push({ node, drawn: true, hand, ...(weapon ? { weapon } : {}) })
      return { node, socket }
    }
    const right = mount('R')
    const left = mount('L')
    actor.paired = true
    actor.hold('revolver', true)
    expect(actor.animation('Gun_Shoot')).toBe('Gun_Shoot')
    expect(actor.muzzleSocket()).toBeNull()
    expect(actor.muzzleSocket(true)).toBe(right.socket)
    actor.root.enabled = true
    expect(left.node.enabled).toBe(false)
    expect(right.node.enabled).toBe(true)
    actor.pairedDrawn = true
    actor.hold('revolver', true)
    expect(actor.animation('Gun_Shoot')).toBe('Gun_Shoot_Pair')
    expect(left.node.enabled).toBe(true)
    expect(right.node.enabled).toBe(true)
    const pose = actor.muzzle()
    expect(pose?.position.distance(right.socket.getPosition())).toBe(0)
    expect(pose?.direction.length()).toBeCloseTo(1)
    actor.hold('rifle', true)
    actor.root.enabled = false
    // A hidden staged rifle must not silently borrow an inactive revolver landmark.
    expect(actor.muzzleSocket(true)).toBeNull()
    const rifle = mount('R', 'rifle')
    actor.hold('rifle', true)
    expect(actor.muzzleSocket()).toBeNull()
    expect(actor.muzzleSocket(true)).toBe(rifle.socket)
    actor.root.enabled = true
    const detached = actor.detach('gun')
    expect(detached).toBe(rifle.node)
    expect(actor.muzzleSocket(true)).toBeNull()
    actor.restoreAttachments()
    expect(actor.muzzleSocket()).toBe(rifle.socket)
    actor.hold('revolver', true)
    const legacyRight = actor.weaponMounts.find((entry) => entry.node === right.node)
    if (!legacyRight) {
      throw new Error('Missing right mount')
    }
    // Historical runtime mounts can omit hand even though the current descriptor type requires it.
    Reflect.deleteProperty(legacyRight, 'hand')
    expect(actor.detach('gun', 'R')).toBe(right.node)
    actor.restoreAttachments()
  } finally {
    actor?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})
