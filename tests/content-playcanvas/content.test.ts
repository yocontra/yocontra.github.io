import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { file } from 'bun'
import collision from '../../src/experiments/out-west/content/collision.json' with { type: 'json' }
import {
  ASSETS,
  COLLISION_VERSION,
  DYNAMIC_ASSETS,
  ENVIRONMENT,
} from '../../src/experiments/out-west/content/manifest.ts'

it('every published asset matches its content-addressed manifest and uses native-supported GLB', async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  for (const [name, asset] of Object.entries({ ...ASSETS, ...DYNAMIC_ASSETS })) {
    const path = `public${asset.url.split('?')[0]}`
    const bytes = new Uint8Array(await file(path).arrayBuffer())
    expect(bytes.byteLength).toBe(asset.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.hash)
    // Frontier shares its content-addressed freight atlas with the texture cache.
    const doc = name === 'frontier' ? await io.read(path) : await io.readBinary(bytes)
    expect(
      doc
        .getRoot()
        .listExtensionsRequired()
        .some((extension) => extension.extensionName === 'EXT_meshopt_compression'),
    ).toBe(false)
    const character = name === 'player' || name.startsWith('outlaw-')
    expect(doc.getRoot().listMeshes().length > 0).toBe(
      !['moves', 'viewmodel-arm-curves'].includes(name),
    )
    expect(doc.getRoot().listSkins().length > 0).toBe(
      character || name === 'dog' || name === 'horse',
    )
    const clips = doc
      .getRoot()
      .listAnimations()
      .map((clip) => clip.getName())
    expect(clips.includes('Idle')).toBe(
      character || ['dog', 'horse', 'coin', 'card', 'crow', 'tumbleweed', 'door'].includes(name),
    )
    expect(clips.includes('Death')).toBe(character)
  }
})

const FREIGHT_ATLAS = /^\.\.\/environments\/textures\/[\da-f]{24}\.color\.ktx2$/u
it('the shipped map resolves its freight atlas locally and fits in one repository file', async () => {
  const path = `public${ASSETS.frontier.url.split('?')[0]}`
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path)
  const atlas = doc
    .getRoot()
    .listTextures()
    .find((texture) => texture.getName() === 'Freight albedo')
  expect(atlas?.getURI()).toMatch(FREIGHT_ATLAS)
  expect(atlas?.getImage()?.length).toBeGreaterThan(0)
  const signs = doc
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === 'Perdition painted signs')
  const image = signs?.getBaseColorTexture()?.getImage()
  if (!image) {
    throw new Error('Missing native sign atlas')
  }
  const ktx = Buffer.from(image)
  expect(ktx.toString('ascii', 1, 7)).toBe('KTX 20')
  expect([ktx.readUInt32LE(20), ktx.readUInt32LE(24), ktx.readUInt32LE(40)]).toEqual([
    4096, 3072, 13,
  ])
  expect(signs?.getMetallicFactor()).toBe(0)
  expect(file(path).size).toBeLessThan(100 * 1024 * 1024)
})

it('static collision version covers complete finite geometry with upward surface winding', () => {
  expect(COLLISION_VERSION).toBe(collision.version)
  expect(
    createHash('sha256')
      .update(JSON.stringify({ boxes: collision.boxes, meshes: collision.meshes }))
      .digest('hex'),
  ).toBe(collision.version)
  expect(collision.boxes.length).toBeGreaterThan(100)
  expect(collision.meshes.length).toBeGreaterThan(10)
  const ids = new Set<string>()
  for (const box of collision.boxes) {
    expect(ids.has(box.id)).toBe(false)
    ids.add(box.id)
    expect(box.center.every(Number.isFinite)).toBe(true)
    expect(box.halfExtents.every((extent) => extent > 0 && Number.isFinite(extent))).toBe(true)
  }
  for (const mesh of collision.meshes) {
    expect(mesh.positions.length % 3).toBe(0)
    expect(mesh.indices.length % 3).toBe(0)
    expect(mesh.positions.every(Number.isFinite)).toBe(true)
    expect(
      mesh.indices.every(
        (index) => Number.isInteger(index) && index >= 0 && index < mesh.positions.length / 3,
      ),
    ).toBe(true)
  }
})

it('licensed environment matches the published bytes and Radiance header', async () => {
  const data = new Uint8Array(await file(`public${ENVIRONMENT.url.split('?')[0]}`).arrayBuffer())
  expect(data.byteLength).toBe(ENVIRONMENT.bytes)
  expect(createHash('sha256').update(data).digest('hex')).toBe(ENVIRONMENT.hash)
  expect(new TextDecoder().decode(data.slice(0, 10))).toBe('#?RADIANCE')
})
