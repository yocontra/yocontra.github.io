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
    const doc = await io.readBinary(bytes)
    expect(
      doc
        .getRoot()
        .listExtensionsRequired()
        .some((extension) => extension.extensionName === 'EXT_meshopt_compression'),
    ).toBe(false)
    const character = name === 'player' || name.startsWith('outlaw-')
    expect(doc.getRoot().listMeshes().length > 0).toBe(name !== 'moves')
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
