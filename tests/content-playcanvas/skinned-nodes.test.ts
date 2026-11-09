import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { GLTF } from '@gltf-transform/core'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { ASSETS, DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import {
  normalizeSkinnedGlb,
  normalizeSkinnedNodes,
} from '../../tools/content/normalize-skinned-nodes.ts'

function fixture(): GLTF.IGLTF {
  return {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'rig', children: [1, 2] },
      { name: 'Hips' },
      {
        name: 'Character',
        mesh: 0,
        skin: 0,
        translation: [1, 2, 3],
        extras: { pieceRanges: [{ name: 'shirt', start: 0, count: 3 }] },
      },
    ],
    meshes: [
      {
        name: 'body',
        primitives: [
          { attributes: { POSITION: 0, TEXCOORD_0: 1, JOINTS_0: 2 }, indices: 3, material: 0 },
          { attributes: { POSITION: 0, TEXCOORD_0: 1, JOINTS_0: 2 }, indices: 4, material: 1 },
        ],
      },
    ],
    skins: [{ joints: [1], inverseBindMatrices: 5 }],
    materials: [{ name: 'Skin' }, { name: 'Dyeable' }],
    animations: [
      {
        samplers: [{ input: 6, output: 7 }],
        channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }],
      },
    ],
  }
}

function glb(json: GLTF.IGLTF): Buffer {
  const encoded = Buffer.from(JSON.stringify(json))
  const padded = (encoded.length + 3) & ~3
  const output = Buffer.alloc(20 + padded + 16, 0x20)
  output.writeUInt32LE(0x46_54_6c_67, 0)
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(padded, 12)
  output.writeUInt32LE(0x4e_4f_53_4a, 16)
  encoded.copy(output, 20)
  output.writeUInt32LE(8, 20 + padded)
  output.writeUInt32LE(0x00_4e_49_42, 24 + padded)
  Buffer.from([0, 255, 127, 3, 42, 17, 9, 1]).copy(output, 28 + padded)
  return output
}

it('skin ownership normalization preserves authored parent, primitive data and all binary bytes', () => {
  const original = fixture()
  const source = glb(original)
  const result = normalizeSkinnedGlb(source)
  const json = JSON.parse(
    result.bytes.subarray(20, 20 + result.bytes.readUInt32LE(12)).toString(),
  ) as GLTF.IGLTF
  expect(result.nodes).toBe(1)
  expect(json.nodes?.slice(0, 2)).toEqual(original.nodes?.slice(0, 2))
  expect(json.nodes?.[2]).toEqual({
    name: 'Character',
    translation: [1, 2, 3],
    extras: { pieceRanges: [{ name: 'shirt', start: 0, count: 3 }] },
    children: [3, 4],
  })
  expect(json.nodes?.slice(3)).toEqual([
    { name: 'native.skin-part.2.0', mesh: 0, skin: 0 },
    { name: 'native.skin-part.2.1', mesh: 1, skin: 0 },
  ])
  expect(json.meshes?.flatMap((mesh) => mesh.primitives)).toEqual(original.meshes?.[0]?.primitives)
  expect(json.skins).toEqual(original.skins)
  expect(json.materials).toEqual(original.materials)
  expect(json.animations).toEqual(original.animations)
  expect(result.bytes.subarray(20 + result.bytes.readUInt32LE(12))).toEqual(
    source.subarray(20 + source.readUInt32LE(12)),
  )
  const again = normalizeSkinnedGlb(result.bytes)
  expect(again.nodes).toBe(0)
  expect(again.bytes).toBe(result.bytes)
})

it('every published character skin has single-primitive native render ownership', async () => {
  const equipment = Object.values(EQUIPMENT).flatMap((asset) =>
    'pair' in asset ? [asset.url, asset.pair.url] : [asset.url],
  )
  const baked: string[] = [ASSETS.player.url, ASSETS.moves.url]
  for (let index = 0; index < 17; index++) {
    const key = `outlaw-${index}` as keyof typeof ASSETS
    baked.push(ASSETS[key].url)
  }
  const paths = [
    ...equipment,
    ...baked,
    DYNAMIC_ASSETS.dog.url,
    DYNAMIC_ASSETS.horse.url,
    DYNAMIC_ASSETS['held-rifle'].url,
    DYNAMIC_ASSETS['held-shotgun'].url,
  ]
  expect(paths).toHaveLength(72)
  for (const url of paths) {
    const bytes = await readFile(`public${url.split('?')[0]}`)
    const result = normalizeSkinnedGlb(bytes)
    expect(result.nodes).toBe(0)
    expect(result.bytes).toBe(bytes)
  }
})

it('shared skinned mesh instances reuse the same primitive resources', () => {
  const json = fixture()
  json.nodes?.push({ name: 'second instance', mesh: 0, skin: 0 })
  expect(normalizeSkinnedNodes(json)).toBe(2)
  expect(json.meshes).toHaveLength(2)
  expect(json.nodes?.slice(4).map((node) => node.mesh)).toEqual([0, 1, 0, 1])
})

it('morph-bearing, rigid and single-primitive nodes retain their original bytes', () => {
  for (const kind of ['morph', 'rigid', 'single', 'shared-rigid'] as const) {
    const json = fixture()
    const node = json.nodes?.[2]
    const mesh = json.meshes?.[0]
    if (!(node && mesh)) {
      throw new Error('Missing fixture body')
    }
    if (kind === 'morph') {
      const primitive = mesh.primitives[0]
      if (primitive) {
        primitive.targets = [{ POSITION: 8 }]
      }
    } else if (kind === 'rigid') {
      const { skin: _skin, ...rigid } = node
      json.nodes?.splice(2, 1, rigid)
    } else if (kind === 'single') {
      mesh.primitives.splice(1)
    } else {
      json.nodes?.push({ name: 'rigid mesh user', mesh: 0 })
    }
    const source = glb(json)
    const result = normalizeSkinnedGlb(source)
    expect(result.nodes).toBe(0)
    expect(result.bytes).toBe(source)
  }
})
