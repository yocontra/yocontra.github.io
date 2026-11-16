import { expect, test as it } from 'bun:test'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRMaterialsUnlit, KHRTextureTransform } from '@gltf-transform/extensions'
import {
  AppBase,
  AppOptions,
  Asset,
  ContainerHandler,
  type ContainerResource,
  NullGraphicsDevice,
  RenderComponentSystem,
  type StandardMaterial,
  Texture,
} from 'playcanvas'
import sharp from 'sharp'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'

function snapshot(material: StandardMaterial) {
  return {
    diffuse: material.diffuse.toArray(),
    emissive: material.emissive.toArray(),
    scalars: [
      material.gloss,
      material.metalness,
      material.bumpiness,
      material.aoIntensity,
      material.opacity,
      material.alphaTest,
      material.cull,
      material.blendType,
    ],
    flags: [material.useLighting, material.useSkybox, material.useMetalness, material.glossInvert],
    maps: [
      material.diffuseMap,
      material.opacityMap,
      material.normalMap,
      material.glossMap,
      material.metalnessMap,
      material.aoMap,
      material.emissiveMap,
    ],
    channels: [material.glossMapChannel, material.metalnessMapChannel, material.aoMapChannel],
    uv: [material.diffuseMapUv, material.normalMapUv, material.glossMapUv, material.aoMapUv],
    transform: [
      material.diffuseMapOffset.toArray(),
      material.diffuseMapTiling.toArray(),
      material.diffuseMapRotation,
    ],
  }
}

it('the actual container loader enables embedded GGX without changing authored PBR or unlit', async () => {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const image = await sharp(Buffer.from([120, 90, 60, 255]), {
    raw: { width: 1, height: 1, channels: 4 },
  })
    .png()
    .toBuffer()
  const texture = doc.createTexture().setImage(image).setMimeType('image/png')
  const material = doc
    .createMaterial('lit')
    .setBaseColorFactor([0.3, 0.5, 0.7, 0.8])
    .setBaseColorTexture(texture)
    .setMetallicFactor(0.25)
    .setRoughnessFactor(0.63)
    .setNormalTexture(texture)
    .setNormalScale(0.4)
    .setOcclusionTexture(texture)
    .setOcclusionStrength(0.35)
    .setMetallicRoughnessTexture(texture)
    .setAlphaMode('MASK')
    .setAlphaCutoff(0.32)
    .setDoubleSided(true)
  material.getOcclusionTextureInfo()?.setTexCoord(1)
  material
    .getBaseColorTextureInfo()
    ?.setExtension(
      'KHR_texture_transform',
      doc
        .createExtension(KHRTextureTransform)
        .createTransform()
        .setOffset([0.2, 0.3])
        .setScale([2, 3])
        .setRotation(0.2),
    )
  const unlit = material
    .clone()
    .setName('unlit')
    .setExtension('KHR_materials_unlit', doc.createExtension(KHRMaterialsUnlit).createUnlit())
  const position = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
  const uv = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
  const scene = doc.createScene()
  for (const source of [material, unlit]) {
    scene.addChild(
      doc
        .createNode()
        .setMesh(
          doc
            .createMesh()
            .addPrimitive(
              doc
                .createPrimitive()
                .setAttribute('POSITION', position)
                .setAttribute('TEXCOORD_0', uv)
                .setAttribute('TEXCOORD_1', uv)
                .setMaterial(source),
            ),
        ),
    )
  }
  const bytes = await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc)
  const device = new NullGraphicsDevice()
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  options.devtools = false
  app.init(options)
  const controller = new AbortController()
  // Exercise the real loadContainer/loadAsset implementation without constructing DOM/rendering.
  const game = Object.create(GameApplication.prototype) as GameApplication
  Reflect.set(game, 'app', app)
  Reflect.set(game, 'controller', controller)
  Reflect.set(game, 'loads', new Map())
  const parsed: StandardMaterial[] = []
  const imageAsset = new Asset('native image fixture', 'texture')
  imageAsset.resource = new Texture(device, { width: 1, height: 1 })
  imageAsset.loaded = true
  app.assets.add(imageAsset)
  app.assets.on('add', (asset: Asset) => {
    if (asset.type !== 'container') {
      return
    }
    asset.file = { url: 'fixture.glb', contents: bytes.slice().buffer }
    const hook = Reflect.get(asset.options, 'material').postprocess
    expect(typeof hook).toBe('function')
    Reflect.get(asset.options, 'material').postprocess = (
      source: unknown,
      native: StandardMaterial,
    ) => {
      const before = snapshot(native)
      expect(native.enableGGXSpecular).toBe(false)
      hook(source, native)
      expect(snapshot(native)).toEqual(before)
      expect(native.enableGGXSpecular).toBe(native.useLighting)
      parsed.push(native)
    }
    const { preprocess } = Reflect.get(asset.options, 'global')
    const { processAsync } = Reflect.get(asset.options, 'image')
    preprocess()
    processAsync({}, (error: unknown, value: unknown) => {
      expect(error).toBeNull()
      expect(value).toBeNull()
    })
    // Supply a real native Texture to the real parser; only Node's unavailable image decoder is replaced.
    Reflect.get(asset.options, 'image').processAsync = (
      _source: unknown,
      done: (error: null, value: Asset) => void,
    ) => done(null, imageAsset)
    Reflect.set(asset, 'checkCancellation', () => {
      controller.abort()
      expect(preprocess).toThrow('Game was closed')
      processAsync({}, (error: unknown, value: Asset) => {
        expect(error).toBeNull()
        expect(value.name).toBe('cancelled-image')
        expect(value.resource).toBeUndefined()
      })
    })
  })
  try {
    const asset = await game.loadContainer('fixture.glb')
    const resource = asset.resource as ContainerResource
    expect(parsed).toHaveLength(2)
    expect(
      resource.materials.map((entry) => (entry.resource as StandardMaterial).enableGGXSpecular),
    ).toEqual([true, false, true, false]) // Missing normals also exercise the parser's flat-shaded clones.
    const lit = parsed[0]
    expect(lit?.gloss).toBe(0.63)
    expect(lit?.metalness).toBe(0.25)
    expect(lit?.bumpiness).toBe(0.4)
    expect(lit?.aoIntensity).toBe(0.35)
    expect(lit?.aoMapUv).toBe(1)
    const clone = lit?.clone()
    expect(clone?.enableGGXSpecular).toBe(true)
    expect(clone?.diffuseMap).toBe(lit?.diffuseMap)
    clone?.destroy()
    const root = resource.instantiateRenderEntity()
    app.root.addChild(root)
    expect(
      root
        .findComponents('render')
        .flatMap((render) => render.meshInstances)
        .map((instance) => (instance.material as StandardMaterial).enableGGXSpecular),
    ).toEqual([true, false])
    Reflect.get(asset, 'checkCancellation')()
  } finally {
    app.destroy()
  }
})
