import { expect, test as it } from 'bun:test'
import { Document, NodeIO } from '@gltf-transform/core'
import {
  AppBase,
  AppOptions,
  Asset,
  ContainerHandler,
  type ContainerResource,
  NullGraphicsDevice,
  RenderComponentSystem,
  Vec3,
} from 'playcanvas'
import { NativeModelLods } from '../../src/experiments/out-west/client/model-lod.ts'

it('native container import can suffix repeated sibling names without changing LOD thresholds', async () => {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const positions = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
  const indices = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
  const mesh = doc
    .createMesh()
    .addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions).setIndices(indices))
  const parent = doc.createNode('cactus bed')
  doc.createScene().addChild(parent)
  for (let i = 0; i < 2; i++) {
    const group = doc.createNode('model-lod:28:4:')
    parent.addChild(group)
    group.addChild(doc.createNode('lod-near:').setMesh(mesh))
    group.addChild(doc.createNode('lod-far:').setMesh(mesh))
  }
  const bytes = await new NodeIO().writeBinary(doc)
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  app.init(options)
  const asset = new Asset('repeated cactus groups', 'container', {
    url: 'cacti.glb',
    contents: bytes.slice().buffer,
  })
  let lod: NativeModelLods | undefined
  try {
    app.assets.add(asset)
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve())
      asset.once('error', reject)
      app.assets.load(asset)
    })
    const root = (asset.resource as ContainerResource).instantiateRenderEntity()
    app.root.addChild(root)
    expect(root.children.map((node) => node.name)).toEqual(['model-lod:28:4:', 'model-lod:28:4:1'])
    lod = new NativeModelLods(root)
    lod.update(new Vec3())
    expect(root.findComponents('render').map((render) => render.enabled)).toEqual([
      true,
      false,
      true,
      false,
    ])
    lod.update(new Vec3(33, 0, 0))
    expect(root.findComponents('render').map((render) => render.enabled)).toEqual([
      false,
      true,
      false,
      true,
    ])
    lod.update(new Vec3(25, 0, 0))
    expect(root.findComponents('render').map((render) => render.enabled)).toEqual([
      false,
      true,
      false,
      true,
    ])
    lod.update(new Vec3(23, 0, 0))
    expect(root.findComponents('render').map((render) => render.enabled)).toEqual([
      true,
      false,
      true,
      false,
    ])
  } finally {
    lod?.destroy()
    app.root.destroy()
    asset.unload()
    app.destroy()
  }
})
