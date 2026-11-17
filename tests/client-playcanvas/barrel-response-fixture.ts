/** Actual parser/renderer/Ammo fixture; the tiny geometry is not an art-quality oracle. */

import { spyOn } from 'bun:test'
import { Document, NodeIO } from '@gltf-transform/core'
import {
  AppBase,
  AppOptions,
  Asset,
  BatchManager,
  ContainerHandler,
  type ContainerResource,
  Entity,
  LAYERID_WORLD,
  NullGraphicsDevice,
  PIXELFORMAT_RGBA8,
  RenderComponentSystem,
  StandardMaterial,
  Texture,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { BARREL_PIECES } from '../../src/experiments/out-west/client/barrel-debris.ts'
import { NativeEnvironment } from '../../src/experiments/out-west/client/environment.ts'
import { BreakableProps } from '../../src/experiments/out-west/client/environment-response.ts'
import { NativeRagdolls } from '../../src/experiments/out-west/client/ragdolls.ts'
import { NativeWilds } from '../../src/experiments/out-west/client/wilds.ts'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'
import { createWorld } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { COLLISION } from '../../src/experiments/out-west/runtime/collision.ts'

async function fragmentBytes() {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene()
  const positions = new Float32Array(
    [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map(
      (v) => v * 0.02,
    ),
  )
  const primitive = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(positions),
    )
    .setIndices(
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('SCALAR')
        .setArray(
          new Uint16Array([
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7,
            3, 1, 2, 6, 1, 6, 5,
          ]),
        ),
    )
    .setMaterial(doc.createMaterial('Fixture fragment placeholder'))
  const mesh = doc.createMesh().addPrimitive(primitive)
  for (const [index, prop] of ENVIRONMENT_PROPS.entries()) {
    for (const [part, name] of BARREL_PIECES.entries()) {
      scene.addChild(
        doc
          .createNode(`barrel-debris:${index}:${name}`)
          .setMesh(mesh)
          .setTranslation([prop.x, 0.2 + part * 0.03, prop.z]),
      )
    }
  }
  return await new NodeIO().writeBinary(doc)
}
export async function barrelFixture(control: { gate?: Promise<void>; reject?: boolean } = {}) {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  options.batchManager = BatchManager
  app.init(options)
  const stage = new Entity('stage', app)
  const town = new Entity('town', app)
  const camera = new Entity('camera', app)
  app.root.addChild(stage)
  stage.addChild(town)
  stage.addChild(camera)
  const woodTexture = new Texture(device, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 })
  const wood = new StandardMaterial()
  wood.diffuseMap = woodTexture
  wood.gloss = 0.24
  wood.update()
  const owners = ENVIRONMENT_PROPS.map((prop) => {
    const owner = new Entity(prop.root, app)
    const lod = new Entity('model-lod:10:2:barrel-fixture', app)
    const near = new Entity('lod-near:barrel-fixture', app)
    const far = new Entity('lod-far:barrel-fixture', app)
    town.addChild(owner)
    owner.addChild(lod)
    lod.addChild(near)
    lod.addChild(far)
    lod.setPosition(...(prop.center as [number, number, number]))
    near.addComponent('render', { type: 'box' })
    far.addComponent('render', { type: 'sphere' })
    for (const node of [near, far]) {
      for (const mi of node.render?.meshInstances ?? []) {
        mi.material = wood
      }
    }
    return { owner, near, far }
  })
  const wall = new Entity('unrelated-wall', app)
  wall.addComponent('render', { type: 'box' })
  town.addChild(wall)
  camera.setPosition(28, 1, 66)
  const cloud = new Texture(device, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 })
  const texture = new Asset('cloud', 'texture')
  texture.resource = cloud
  const bytes = await fragmentBytes()
  let releases = 0
  let requests = 0
  let acquired: Asset | undefined
  const game = {
    app,
    stage,
    camera,
    environment: async () => undefined,
    loadTexture: async () => texture,
    async loadContainer(url: string) {
      requests++
      await control.gate
      if (control.reject) {
        throw new Error('Injected fragment failure')
      }
      const asset = new Asset(url, 'container', { url, contents: new Uint8Array(bytes).buffer })
      app.assets.add(asset)
      await new Promise<void>((resolve, reject) => {
        asset.once('load', resolve)
        asset.once('error', reject)
        app.assets.load(asset)
      })
      acquired = asset
      return asset
    },
    releaseContainer() {
      releases++
      acquired?.unload()
      if (acquired) {
        app.assets.remove(acquired)
      }
    },
  } as unknown as GameApplication
  const wilds = spyOn(NativeWilds, 'create').mockResolvedValue({
    destroy: () => undefined,
  } as NativeWilds)
  let environment: NativeEnvironment
  try {
    environment = new NativeEnvironment(game, true)
    await environment.ready
  } finally {
    wilds.mockRestore()
  }
  const asset = new Asset('town', 'container')
  asset.resource = {
    animations: [],
    materials: [],
    data: { gltf: { materials: [] } },
  } as unknown as ContainerResource
  environment.attach(town, asset)
  const ragdolls = await NativeRagdolls.create(game, {
    version: 'barrel-presentation',
    boxes: [
      { center: [64, -0.5, 64], halfExtents: [128, 0.5, 128] },
      ...COLLISION.boxes.filter((box) =>
        ENVIRONMENT_PROPS.some((prop) => `cover:${prop.cover}` === box.id),
      ),
    ],
    meshes: [],
  })
  const physics = ragdolls.share(() => false)
  const physicsDevice = physics.app.graphicsDevice
  const props = new BreakableProps(game, town, ragdolls, '/fixtures/barrel-fragments.glb')
  const world = createWorld()
  world.tick = 100
  return {
    app,
    props,
    world,
    camera,
    owners,
    wall,
    physics,
    stage,
    leases: () => ({ requests, releases }),
    drawn: () => app.scene.layers.getLayerById(LAYERID_WORLD)?.meshInstances ?? [],
    async destroy() {
      props.destroy()
      props.destroy()
      await props.ready.catch(() => undefined)
      environment.destroy()
      ragdolls.destroy()
      wood.destroy()
      woodTexture.destroy()
      cloud.destroy()
      app.destroy()
      return {
        renderBuffers: device.buffers.size,
        renderTextures: device.textures.size,
        physicsBuffers: physicsDevice.buffers.size,
        physicsTextures: physicsDevice.textures.size,
      }
    },
  }
}
