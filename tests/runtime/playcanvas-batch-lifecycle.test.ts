import { expect, test as it } from 'bun:test'

const [production, debug, profiler] = await Promise.all([
  import('playcanvas'),
  import('playcanvas/debug'),
  import('playcanvas/profiler'),
])

const builds = { production, debug, profiler }

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
