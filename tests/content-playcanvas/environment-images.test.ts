import { expect, test as it } from 'bun:test'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureTransform } from '@gltf-transform/extensions'
import sharp from 'sharp'
import { deduplicateEnvironmentImages } from '../../tools/content/environment-textures.ts'

it('shares identical images while preserving material settings, samplers, UVs and geometry', async () => {
  const doc = new Document()
  const png = async (values: number[]) =>
    sharp(Buffer.from(values), { raw: { width: 1, height: 1, channels: 4 } })
      .png()
      .toBuffer()
  const pixels = await png([60, 90, 120, 255])
  const first = doc.createTexture('first alias').setImage(pixels).setMimeType('image/png')
  const second = doc.createTexture('second alias').setImage(pixels.slice()).setMimeType('image/png')
  const unique = doc
    .createTexture('unique normal')
    .setImage(await png([128, 128, 255, 255]))
    .setMimeType('image/png')
  const a = doc.createMaterial('cloth').setBaseColorTexture(first).setRoughnessFactor(0.9)
  const b = doc
    .createMaterial('metal')
    .setBaseColorTexture(second)
    .setMetallicFactor(0.75)
    .setRoughnessFactor(0.3)
    .setNormalTexture(unique)
    .setNormalScale(0.4)
    .setAlphaMode('MASK')
    .setAlphaCutoff(0.4)
  b.getBaseColorTextureInfo()
    ?.setTexCoord(1)
    .setWrapS(33_071)
    .setExtension(
      'KHR_texture_transform',
      doc
        .createExtension(KHRTextureTransform)
        .createTransform()
        .setOffset([0.2, 0.4])
        .setScale([2, 3]),
    )
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
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2]))
  const scene = doc.createScene('scene')
  for (const material of [a, b]) {
    scene.addChild(
      doc
        .createNode(material.getName())
        .setTranslation([2, 3, 4])
        .setMesh(
          doc
            .createMesh()
            .addPrimitive(
              doc
                .createPrimitive()
                .setAttribute('POSITION', positions)
                .setAttribute('TEXCOORD_0', uv)
                .setAttribute('TEXCOORD_1', uv)
                .setIndices(indices)
                .setMaterial(material),
            ),
        ),
    )
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const before = await io.readBinary(await io.writeBinary(doc))
  await deduplicateEnvironmentImages(doc)
  expect(doc.getRoot().listTextures()).toHaveLength(2)
  expect(a.getBaseColorTexture()).toBe(b.getBaseColorTexture())
  expect(b.getNormalTexture()).not.toBe(b.getBaseColorTexture())
  const written = await io.writeBinary(doc)
  const after = await io.readBinary(written)
  expect(
    after
      .getRoot()
      .listMaterials()
      .map((material) => material.getName()),
  ).toEqual(['cloth', 'metal'])
  // Image aliases may merge; all properties of the actual geometry and bound materials stay equal.
  for (const candidate of [before, after]) {
    for (const texture of candidate.getRoot().listTextures()) {
      texture.setName('')
    }
  }
  expect(after.getRoot().listNodes()).toHaveLength(before.getRoot().listNodes().length)
  for (const [i, node] of before.getRoot().listNodes().entries()) {
    const counterpart = after.getRoot().listNodes()[i]
    expect(counterpart && node.equals(counterpart)).toBe(true)
  }
  await deduplicateEnvironmentImages(doc)
  expect(await io.writeBinary(doc)).toEqual(written)
})
