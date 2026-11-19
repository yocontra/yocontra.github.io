import { expect, test as it } from 'bun:test'

const [production, debug, profiler] = await Promise.all([
  import('playcanvas'),
  import('playcanvas/debug'),
  import('playcanvas/profiler'),
])

const builds = { production, debug, profiler }

function sceneWithEarlyBatch(pc: typeof production, packedDirections = false) {
  const device = new pc.NullGraphicsDevice()
  const app = new pc.AppBase(device.canvas)
  const options = new pc.AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [pc.RenderComponentSystem]
  options.resourceHandlers = []
  options.batchManager = pc.BatchManager
  options.devtools = false
  app.init(options)
  const group = app.batcher.addGroup('Town before first render', false, 24)
  const node = new pc.Entity('Town mesh', app)
  app.root.addChild(node)
  const mesh = new pc.Mesh(device)
  mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0])
  if (packedDirections) {
    node.setLocalScale(0.5, 0.5, 0.75)
    mesh.setVertexStream(
      pc.SEMANTIC_NORMAL,
      new Int16Array([32_767, 0, 0, 23_170, 23_170, 0, -32_767, 0, 0]),
      3,
      undefined,
      pc.TYPE_INT16,
      true,
    )
    mesh.setVertexStream(
      pc.SEMANTIC_TANGENT,
      new Int16Array([0, 32_767, 0, 32_767, 0, 23_170, 23_170, -32_767, 0, -32_767, 0, -32_767]),
      4,
      undefined,
      pc.TYPE_INT16,
      true,
    )
  }
  mesh.setIndices([0, 1, 2])
  mesh.update()
  const material = new pc.StandardMaterial()
  node.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material, node)] })
  if (!node.render) {
    throw new Error('Expected a native render component')
  }
  node.render.batchGroupId = group.id
  app.batcher.generate([group.id])
  return {
    app,
    device,
    close() {
      app.batcher.removeGroup(group.id)
      material.destroy()
      app.destroy()
    },
  }
}

function fixture(pc: typeof production, dynamic: boolean) {
  const device = new pc.NullGraphicsDevice()
  const app = new pc.AppBase(device.canvas)
  const options = new pc.AppOptions()
  options.graphicsDevice = device
  options.componentSystems = []
  options.resourceHandlers = []
  options.devtools = false
  app.init(options)
  const scene = app.scene
  const manager = new pc.BatchManager(device, app.root, scene)
  const group = manager.addGroup('Rider equipment lifecycle', dynamic, 24, undefined, [])
  const texture = new pc.Texture(device, { width: 1, height: 1 })
  const source = new pc.StandardMaterial()
  source.diffuseMap = texture
  source.update()
  source.prepareForRender(device, scene)
  const mesh = new pc.Mesh(device)
  mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0])
  mesh.setIndices([0, 1, 2])
  mesh.update()
  const instance = new pc.MeshInstance(mesh, source, new pc.GraphNode())
  const create = () => {
    const batch = manager.create([instance], dynamic, group.id)
    const material = batch.meshInstance?.material
    if (!(material instanceof pc.StandardMaterial)) {
      throw new Error('Expected a real native batch material')
    }
    material.prepareForRender(device, scene)
    return { batch, material, buffer: material.uniformBuffer }
  }
  const close = () => {
    manager.removeGroup(group.id)
    instance.destroy()
    source.destroy()
    texture.destroy()
    manager.destroy()
    app.destroy()
  }
  return { device, scene, manager, group, source, texture, create, close }
}

for (const [build, pc] of Object.entries(builds)) {
  it(`${build}: the first render replaces already generated town batches`, () => {
    const { app, device, close } = sceneWithEarlyBatch(pc)
    try {
      const world = app.scene.layers.getLayerByName('World')
      const first = world?.meshInstances[0]?.mesh?.vertexBuffer
      if (!(world && first)) {
        throw new Error('Expected the early batch in the world layer')
      }
      expect(device.buffers.has(first)).toBe(true)
      expect(world.meshInstances).toHaveLength(1)
      expect(world.shadowCasters).toHaveLength(1)
      const buffers = device.buffers.size

      app.fire('prerender')

      expect(world.meshInstances).toHaveLength(1)
      expect(world.shadowCasters).toHaveLength(1)
      expect(device.buffers.has(first)).toBe(false)
      expect(device.buffers.size).toBe(buffers)
    } finally {
      close()
    }
  })

  it(`${build}: static batching preserves packed directions under nonuniform scale`, () => {
    const { app, close } = sceneWithEarlyBatch(pc, true)
    try {
      const batch = app.scene.layers.getLayerByName('World')?.meshInstances[0]?.mesh
      if (!batch) {
        throw new Error('Expected a static batch mesh')
      }
      const normals: number[] = []
      const tangents: number[] = []
      batch.getVertexStream(pc.SEMANTIC_NORMAL, normals)
      batch.getVertexStream(pc.SEMANTIC_TANGENT, tangents)
      expect(normals).toEqual([32_767, 0, 0, 32_767, 32_767, 0, -32_767, 0, 0])
      expect(tangents).toEqual([
        0, 32_767, 0, 32_767, 0, 32_767, 21_845, -32_767, 0, -32_767, 0, -32_767,
      ])
    } finally {
      close()
    }
  })

  it(`${build}: retiring a dynamic batch releases its clone and preserves the source`, () => {
    const f = fixture(pc, true)
    try {
      const sourceBuffer = f.source.uniformBuffer
      const { batch, material, buffer } = f.create()
      expect(material).not.toBe(f.source)
      expect(f.device.buffers.has(buffer)).toBe(true)
      batch.destroy(f.scene, [])
      expect(f.device.buffers.has(buffer)).toBe(false)
      expect(material.uniformBuffer).toBeNull()
      expect(f.device.buffers.has(sourceBuffer)).toBe(true)
      expect(f.source.diffuseMap).toBe(f.texture)
      expect(f.texture.device).toBe(f.device)
      const remaining = f.device.buffers.size
      batch.destroy(f.scene, [])
      expect(f.device.buffers.size).toBe(remaining)
    } finally {
      f.close()
    }
  })

  it(`${build}: repeated equipment batch rebuilds keep the original resource count`, () => {
    const f = fixture(pc, true)
    try {
      const initial = f.device.buffers.size
      for (let rebuild = 0; rebuild < 24; rebuild++) {
        const { buffer } = f.create()
        expect(f.device.buffers.has(buffer)).toBe(true)
        // Exercise the engine regeneration path used when equipment visibility changes.
        f.manager.generate([f.group.id])
        expect(f.device.buffers.has(buffer)).toBe(false)
        expect(f.device.buffers.size).toBe(initial)
      }
    } finally {
      f.close()
    }
  })

  it(`${build}: static batching leaves its borrowed source material alive`, () => {
    const f = fixture(pc, false)
    try {
      const { batch, material, buffer } = f.create()
      expect(material).toBe(f.source)
      batch.destroy(f.scene, [])
      expect(f.device.buffers.has(buffer)).toBe(true)
      expect(material.diffuseMap).toBe(f.texture)
      expect(f.texture.device).toBe(f.device)
    } finally {
      f.close()
    }
  })
}
