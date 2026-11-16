/** Serialized native witness only; test-only mutations restore source UV1 and release all temporary resources. */
import type * as Pc from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import type { NativeEnvironment } from '../../src/experiments/out-west/client/environment.ts'
import type { FreightCell } from './freight-crates-contract.ts'

export interface NativeFreight {
  game: GameApplication
  town: Pc.Entity
  environment: NativeEnvironment
  device: Pc.GraphicsDevice
  execution: { create: string; destroy: string }
}
/** Test-only native reference: actual authored pose; original source UV streams restored on disposal. */
export async function prepareUvWitness(args: {
  mode: string
  tier: string
  cell: FreightCell
  constants: { format: number; filter: number; repeat: number }
}) {
  const { game, town } = Reflect.get(globalThis, '__freightNative') as NativeFreight
  const branch = town.findByName(`lod-${args.tier}:freight-${args.cell.coverIndex}`)
  const source = branch?.findByName(`freight-cell:${args.cell.id}`) as Pc.Entity | null
  if (!source) {
    throw new Error('Missing authored UV reference source')
  }
  const groupIds = new Set(
    (town.findComponents('render') as Pc.RenderComponent[])
      .map((render) => render.batchGroupId)
      .filter((id) => id >= 0),
  )
  const clone = source.clone()
  const position = source.getPosition().clone()
  const rotation = source.getRotation().clone()
  game.stage.addChild(clone)
  clone.setPosition(position)
  clone.setRotation(rotation)
  clone.enabled = true
  town.enabled = false
  const renders = clone.findComponents('render') as Pc.RenderComponent[]
  const original = renders[0]?.meshInstances[0]?.material as Pc.StandardMaterial | undefined
  if (original?.name !== 'Freight scanned atlas' || !original.diffuseDetailMap) {
    throw new Error('Missing native freight cloud material')
  }
  const material = original.clone()
  const world = material.getShaderChunks('glsl').get('uv1VS') ?? ''
  if (!world.includes('dPositionW.xz / 1024.0') || material.shaderChunksVersion !== '2.23') {
    throw new Error('Missing freight world UV chunk')
  }
  const Texture = original.diffuseDetailMap.constructor as typeof Pc.Texture
  const texture = new Texture(game.app.graphicsDevice, {
    width: 16,
    height: 16,
    format: args.constants.format,
    mipmaps: false,
    srgb: false,
    minFilter: args.constants.filter,
    magFilter: args.constants.filter,
    addressU: args.constants.repeat,
    addressV: args.constants.repeat,
  })
  const pixels = texture.lock() as Uint8Array
  for (let i = 0; i < 256; i++) {
    const shade = 80 + (((i % 16) * 17 + Math.floor(i / 16) * 37) % 176)
    pixels.set([shade, shade, shade, 255], i * 4)
  }
  texture.unlock()
  material.diffuseDetailMap = texture
  material.diffuseDetailMapTiling.set(37, 53)
  material.diffuseDetailMapOffset.set(0.137, 0.263)
  material.update()
  const batch =
    args.mode === 'batched' ? game.app.batcher?.addGroup('freight-uv-proof', false, 32) : undefined
  for (const render of renders) {
    render.enabled = true
    render.batchGroupId = batch?.id ?? -1
    for (const mi of render.meshInstances) {
      mi.material = material
    }
  }
  if (batch) {
    groupIds.add(batch.id)
  }
  // Numeric IDs release old town batches; the pinned no-argument path returns string keys.
  game.app.batcher?.generate([...groupIds])
  const target = args.cell.min.map((v, i) => (v + (args.cell.max[i] ?? 0)) / 2) as [
    number,
    number,
    number,
  ]
  const radius = args.tier === 'far' ? 13 : 3
  game.camera.setPosition(
    target[0] - radius * 0.7,
    target[1] + radius * 0.55,
    target[2] + radius * 0.7,
  )
  game.camera.lookAt(...target)
  if (!game.camera.camera) {
    throw new Error('Missing UV witness camera')
  }
  game.camera.camera.fov = args.tier === 'far' ? 10 : 45
  const wait = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((done) => requestAnimationFrame(() => done()))
      if (
        game.app.graphicsDevice.width !== 1280 ||
        game.app.graphicsDevice.height !== 720 ||
        game.app.timeScale !== 0
      ) {
        throw new Error('UV witness resolution/clock changed')
      }
    }
  }
  await wait()
  const instances = batch
    ? (
        (game.app.batcher
          ? Reflect.get(game.app.batcher, 'getBatches').call(game.app.batcher, batch.id)
          : []) as { meshInstance: Pc.MeshInstance | null }[]
      ).flatMap((b) => (b.meshInstance ? [b.meshInstance] : []))
    : renders.flatMap((r) => r.meshInstances)
  const isolated = [
    ...new Set(game.app.scene.layers.layerList.filter((layer) => layer.name === 'World')),
  ].map((layer) => {
    const count = layer.meshInstances.length
    layer.removeMeshInstances([...layer.meshInstances])
    layer.addMeshInstances(instances)
    return { layer: layer.name, removed: count, witnesses: instances.length }
  })
  await wait()
  const meshes = [...new Set(instances.flatMap((mi) => (mi.mesh ? [mi.mesh] : [])))]
  const streams = meshes.map((mesh) => {
    if (!mesh) {
      throw new Error('Missing witness mesh')
    }
    const instance = instances.find((mi) => mi.mesh === mesh)
    if (!instance) {
      throw new Error('Missing witness transform')
    }
    const positions: number[] = []
    const uv: number[] = []
    mesh.getVertexStream('POSITION', positions)
    mesh.getVertexStream('TEXCOORD1', uv)
    if (uv.length === 0) {
      throw new Error('Missing shared local UV1 feature')
    }
    return { mesh, positions, uv, matrix: Array.from(instance.node.getWorldTransform().data) }
  })
  const shaders = instances
    .flatMap((mi) =>
      [...(Reflect.get(mi, '_shaderCache') as Map<number, { shader: Pc.Shader }>).values()].map(
        (cache) => cache.shader,
      ),
    )
    .filter(
      (shader) => shader.ready && shader.definition.vshader?.includes('dPositionW.xz / 1024.0'),
    )
  if (shaders.length === 0) {
    throw new Error('No compiled native world UV shader in active mesh cache')
  }
  Reflect.set(globalThis, '__freightUvInspect', { game, material, texture, instances, streams })
  Reflect.set(globalThis, '__freightUvFrame', async (step: string, values: number[][]) => {
    if (step === 'hidden') {
      for (const mi of instances) {
        mi.visible = false
      }
    }
    material.getShaderChunks('glsl').set('uv1VS', 'vec2 getUv1() { return vertex_texCoord1; }')
    material.update()
    if (step === 'reference') {
      for (const [i, s] of streams.entries()) {
        s.mesh.setVertexStream('TEXCOORD1', new Float32Array(values[i] ?? []), 2)
        s.mesh.update()
      }
    }
    await wait()
    return {
      resolution: [game.app.graphicsDevice.width, game.app.graphicsDevice.height],
      timeScale: game.app.timeScale,
    }
  })
  Reflect.set(globalThis, '__freightUvDispose', () => {
    for (const s of streams) {
      s.mesh.setVertexStream('TEXCOORD1', new Float32Array(s.uv), 2)
      s.mesh.update()
    }
    if (batch) {
      game.app.batcher?.removeGroup(batch.id)
    }
    clone.destroy()
    material.destroy()
    texture.destroy()
  })
  return {
    streams: streams.map(({ positions, matrix }) => ({ positions, matrix })),
    shaders: shaders.map((s) => ({ id: s.id, vertex: s.definition.vshader })),
    pose: source.getPosition().toArray(),
    isolated,
  }
}

/** Read-only ownership and compiled-sampler evidence for each rendered witness stage. */
export function captureUvState() {
  const { game, material, texture, instances, streams } = Reflect.get(
    globalThis,
    '__freightUvInspect',
  ) as {
    game: GameApplication
    material: Pc.StandardMaterial
    texture: Pc.Texture
    instances: Pc.MeshInstance[]
    streams: { uv: number[] }[]
  }
  return {
    material: {
      id: material.id,
      uv: material.diffuseDetailMapUv,
      texture: Reflect.get(texture, 'id'),
      activeTexture:
        Reflect.get(material.getParameter('texture_diffuseDetailMap') ?? {}, 'data') === texture,
      chunk: material.getShaderChunks('glsl').get('uv1VS'),
    },
    instances: instances.map((mi) => ({
      name: mi.node.name,
      material: mi.material?.id,
      intendedMaterial: mi.material === material,
      visible: mi.visible,
      visibleThisFrame: mi.visibleThisFrame,
      layers: game.app.scene.layers.layerList
        .filter((layer) => layer.meshInstances.includes(mi))
        .map((layer) => layer.name),
      shaders: [
        ...(Reflect.get(mi, '_shaderCache') as Map<number, { shader: Pc.Shader }>).values(),
      ].map(({ shader }) => ({
        id: shader.id,
        ready: shader.ready,
        vertex: shader.definition.vshader,
        fragment: shader.definition.fshader,
      })),
    })),
    localUV1: streams.map(({ uv }) => ({
      min: [
        Math.min(...uv.filter((_, i) => i % 2 === 0)),
        Math.min(...uv.filter((_, i) => i % 2 === 1)),
      ],
      max: [
        Math.max(...uv.filter((_, i) => i % 2 === 0)),
        Math.max(...uv.filter((_, i) => i % 2 === 1)),
      ],
    })),
  }
}

/** Pixel comparison keeps both the sampler-negative and actual draw-visibility controls explicit. */
export function compareUvFrames(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
  c: Uint8Array | undefined,
  hidden: Uint8Array | undefined,
) {
  if (
    !(a && b && c && hidden) ||
    a.length !== b.length ||
    a.length !== c.length ||
    a.length !== hidden.length
  ) {
    throw new Error('Missing UV reference pixel buffers')
  }
  let maximumError = 0
  let negativePixels = 0
  let hiddenPixels = 0
  for (let i = 0; i < a.length; i += 3) {
    let difference = 0
    let visibility = 0
    for (let ch = 0; ch < 3; ch++) {
      maximumError = Math.max(maximumError, Math.abs((a[i + ch] ?? 0) - (b[i + ch] ?? 0)))
      difference = Math.max(difference, Math.abs((a[i + ch] ?? 0) - (c[i + ch] ?? 0)))
      visibility = Math.max(visibility, Math.abs((a[i + ch] ?? 0) - (hidden[i + ch] ?? 0)))
    }
    if (difference > 2) {
      negativePixels++
    }
    if (visibility > 2) {
      hiddenPixels++
    }
  }
  return { maximumError, negativePixels, hiddenPixels }
}
