import { expect, test as it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { spawn } from 'bun'
import sharp from 'sharp'
import { optimizeAsset } from '../../tools/content/optimize.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

async function fixture(path: string, width: number, height: number) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const image = async (name: string, rgba: [number, number, number, number]) => {
    const pixels = Buffer.alloc(width * height * 4)
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels.set(rgba, offset)
      // High-frequency detail must survive lossless encoding, including packed data channels.
      pixels[offset] = ((offset / 4) % 2 ? rgba[0] : rgba[0] + 5) % 256
    }
    return doc
      .createTexture(name)
      .setImage(
        await sharp(pixels, { raw: { width, height, channels: 4 } })
          .png()
          .toBuffer(),
      )
      .setMimeType('image/png')
  }
  const [albedo, normal, arm] = await Promise.all([
    image('albedo', [120, 45, 18, 137]),
    image('normal', [127, 128, 254, 255]),
    image('arm', [23, 149, 236, 255]),
  ])
  const material = doc
    .createMaterial('surface')
    .setBaseColorTexture(albedo)
    .setNormalTexture(normal)
    .setMetallicRoughnessTexture(arm)
    .setOcclusionTexture(arm)
    .setAlphaMode('MASK')
    .setAlphaCutoff(0.4)
    .setRoughnessFactor(0.85)
    .setMetallicFactor(0.7)
    .setExtras({ nativePbr: { ao: true } })
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer)
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer)
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer)
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', positions)
    .setAttribute('TEXCOORD_0', uv)
    .setIndices(indices)
    .setMaterial(material)
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)))
  await io.write(path, doc)
  return doc
}

it('preserve profile retains source-resolution texture bytes and PBR bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'out-west-textures-'))
  try {
    const path = join(dir, 'source.glb')
    const source = await fixture(path, 1536, 384)
    await optimizeAsset(path, 'preserve')
    const result = await io.read(path)
    const actual = result.getRoot().listTextures()
    for (const expected of source.getRoot().listTextures()) {
      const texture = actual.find((item) => item.getName() === expected.getName())
      expect(texture?.getImage()).toEqual(expected.getImage())
      expect(texture?.getSize()).toEqual([1536, 384])
    }
    expect(materialState(result)).toEqual(expectedMaterial)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const expectedMaterial = {
  sharedArm: true,
  normal: 'normal',
  alphaMode: 'MASK' as const,
  alphaCutoff: 0.4,
  roughness: 0.85,
  metallic: 0.7,
  extras: { nativePbr: { ao: true } },
}
function materialState(doc: Document) {
  const material = doc.getRoot().listMaterials()[0]
  return {
    sharedArm: material?.getMetallicRoughnessTexture() === material?.getOcclusionTexture(),
    normal: material?.getNormalTexture()?.getName(),
    alphaMode: material?.getAlphaMode(),
    alphaCutoff: material?.getAlphaCutoff(),
    roughness: material?.getRoughnessFactor(),
    metallic: material?.getMetallicFactor(),
    extras: material?.getExtras(),
  }
}

it('high profile preserves all albedo, alpha, normal and ARM texels below its size limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'out-west-textures-'))
  try {
    const path = join(dir, 'hero.glb')
    const source = await fixture(path, 1536, 384)
    await optimizeAsset(path, 'high')
    const result = await io.read(path)
    await Promise.all(
      source
        .getRoot()
        .listTextures()
        .map(async (expected) => {
          const actual = result
            .getRoot()
            .listTextures()
            .find((item) => item.getName() === expected.getName())
          expect(actual?.getSize()).toEqual([1536, 384])
          expect(actual?.getMimeType()).toBe('image/webp')
          const actualImage = actual?.getImage()
          const expectedImage = expected.getImage()
          if (!(actualImage && expectedImage)) {
            throw new Error('Missing source or derivative texture')
          }
          expect(await sharp(actualImage).ensureAlpha().raw().toBuffer()).toEqual(
            await sharp(expectedImage).ensureAlpha().raw().toBuffer(),
          )
        }),
    )
    expect(materialState(result)).toEqual(expectedMaterial)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const [quality, width, height] of [
  ['high', 4096, 512],
  ['low', 1024, 128],
] as const) {
  it(`${quality} derivative caps dimensions without stretching or changing the source`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'out-west-textures-'))
    try {
      const source = join(dir, 'master.glb')
      const output = join(dir, `${quality}.glb`)
      await fixture(source, 4608, 576)
      const bytes = await readFile(source)
      const command = spawn(
        ['bun', 'tools/optimize-gltf.ts', source, output, `--textures=${quality}`],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const stderr = await new Response(command.stderr).text()
      expect(await command.exited, stderr).toBe(0)
      expect(await readFile(source)).toEqual(bytes)
      const result = await io.read(output)
      for (const texture of result.getRoot().listTextures()) {
        expect(texture.getSize()).toEqual([width, height])
      }
      expect(materialState(result)).toEqual(expectedMaterial)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
