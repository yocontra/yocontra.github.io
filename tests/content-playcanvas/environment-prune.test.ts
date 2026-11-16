import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { type Accessor, Document, NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import sharp from 'sharp'
import { pruneNativeEnvironment } from '../../tools/content/environment-prune.ts'

const signature = (accessor: Accessor | null) => {
  const values = accessor?.getArray()
  if (!(accessor && values)) {
    throw new Error('Missing fixture accessor')
  }
  return {
    type: accessor.getComponentType(),
    normalized: accessor.getNormalized(),
    values: createHash('sha256')
      .update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
      .digest('hex'),
  }
}

it('final native resource prune retains exact scene/color/UV/morph/animation data and solid PBR maps', async () => {
  const doc = new Document()
  doc.createExtension(KHRMeshQuantization).setRequired(true)
  const buffer = doc.createBuffer()
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setBuffer(buffer)
    .setArray(new Float32Array([0.001, 0.002, 0.003, 0.004, 0.005, 0.006]))
  const color = doc
    .createAccessor()
    .setType('VEC4')
    .setBuffer(buffer)
    .setNormalized(true)
    .setArray(
      new Uint16Array([65_535, 12_345, 32_768, 65_535, 1, 2, 3, 65_535, 100, 200, 300, 65_535]),
    )
  const normal = doc
    .createAccessor()
    .setType('VEC3')
    .setBuffer(buffer)
    .setNormalized(true)
    .setArray(new Int16Array([0, 0, 32_767, 0, 0, 32_767, 0, 0, 32_767]))
  const tangent = doc
    .createAccessor()
    .setType('VEC4')
    .setBuffer(buffer)
    .setNormalized(true)
    .setArray(new Int16Array([32_767, 0, 0, 32_767, 32_767, 0, 0, -32_767, 32_767, 0, 0, 32_767]))
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2]))
  const morph = doc
    .createAccessor()
    .setType('VEC3')
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 0.01, 0, 0, 0.02, 0, 0]))
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
  const texture = doc.createTexture('solid image').setImage(png).setMimeType('image/png')
  const material = doc
    .createMaterial('kept material')
    .setExtras({ freightWorldUv1: true })
    .setBaseColorFactor([0.8, 0.7, 0.6, 1])
    .setBaseColorTexture(texture)
  const primitive = doc
    .createPrimitive()
    .setIndices(indices)
    .setMaterial(material)
    .setAttribute('POSITION', positions)
    .setAttribute('TEXCOORD_0', uv)
    .setAttribute('TEXCOORD_1', uv)
    .setAttribute('COLOR_0', color)
    .setAttribute('NORMAL', normal)
    .setAttribute('TANGENT', tangent)
    .addTarget(doc.createPrimitiveTarget().setAttribute('POSITION', morph))
  const mesh = doc.createMesh('shared').setWeights([0]).addPrimitive(primitive)
  const a = doc.createNode('a').setMesh(mesh).setTranslation([1, 2, 3])
  const b = doc.createNode('b').setMesh(mesh).setTranslation([4, 5, 6])
  const helper = doc.createNode('required empty helper').setExtras({ retained: 42 })
  doc.createScene().addChild(a).addChild(b).addChild(helper)
  doc.createMesh('orphan').addPrimitive(primitive.clone())
  const time = doc
    .createAccessor()
    .setType('SCALAR')
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 1]))
  const weights = time.clone().setArray(new Float32Array([0, 1]))
  const sampler = doc
    .createAnimationSampler()
    .setInput(time)
    .setOutput(weights)
    .setInterpolation('LINEAR')
  doc
    .createAnimation('Wind')
    .addSampler(sampler)
    .addChannel(
      doc.createAnimationChannel().setTargetNode(a).setTargetPath('weights').setSampler(sampler),
    )
  const before = [positions, uv, color, normal, tangent, indices, morph, time, weights].map(
    signature,
  )

  await pruneNativeEnvironment(doc)
  const io = new NodeIO().registerExtensions([KHRMeshQuantization])
  const copy = await io.readBinary(await io.writeBinary(doc))
  const root = copy.getRoot()
  const nodes = root.listNodes()
  const first = nodes.find((node) => node.getName() === 'a')
  const second = nodes.find((node) => node.getName() === 'b')
  const p = first?.getMesh()?.listPrimitives()[0]
  const clip = root.listAnimations()[0]
  const channel = clip?.listChannels()[0]
  if (!(first && second && p && channel)) {
    throw new Error('Missing retained scene')
  }
  const after = [
    p.getAttribute('POSITION'),
    p.getAttribute('TEXCOORD_1'),
    p.getAttribute('COLOR_0'),
    p.getAttribute('NORMAL'),
    p.getAttribute('TANGENT'),
    p.getIndices(),
    p.listTargets()[0]?.getAttribute('POSITION') ?? null,
    channel.getSampler()?.getInput() ?? null,
    channel.getSampler()?.getOutput() ?? null,
  ].map(signature)
  expect(after).toEqual(before)
  expect(root.listExtensionsRequired().map((extension) => extension.extensionName)).toEqual([
    'KHR_mesh_quantization',
  ])
  expect(root.listMeshes()).toHaveLength(1)
  expect(first.getMesh()).toBe(second.getMesh())
  expect(first.getTranslation()).toEqual([1, 2, 3])
  expect(second.getTranslation()).toEqual([4, 5, 6])
  expect(nodes.find((node) => node.getName() === 'required empty helper')?.getExtras()).toEqual({
    retained: 42,
  })
  expect(p.getAttribute('TEXCOORD_0')).toBe(p.getAttribute('TEXCOORD_1'))
  expect(p.getMaterial()?.getExtras()).toEqual({ freightWorldUv1: true })
  expect(p.getMaterial()?.getBaseColorFactor()).toEqual([0.8, 0.7, 0.6, 1])
  expect(Buffer.from(root.listTextures()[0]?.getImage() ?? [])).toEqual(png)
  expect(root.listTextures()).toHaveLength(1)
  expect(clip?.getName()).toBe('Wind')
  expect(channel.getTargetNode()).toBe(first)
  expect(channel.getTargetPath()).toBe('weights')
  expect(channel.getSampler()?.getInterpolation()).toBe('LINEAR')
})
