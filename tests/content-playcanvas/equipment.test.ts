import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { CATALOG } from '../../src/experiments/out-west/data/catalog.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const slots = ['outfit', 'hat', 'gun', 'spurs', 'extra', 'holster']

it('every three-dimensional catalogue item has a verified native-compatible asset', async () => {
  const items = CATALOG.filter((item) => slots.includes(item.slot))
  expect(Object.keys(EQUIPMENT).sort((a, b) => a.localeCompare(b))).toEqual(
    items.map((item) => item.id).sort((a, b) => a.localeCompare(b)),
  )
  for (const item of items) {
    const asset = EQUIPMENT[item.id as keyof typeof EQUIPMENT]
    const bytes = await readFile(`public${asset.url.split('?')[0]}`)
    expect(bytes.byteLength).toBe(asset.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.hash)
    const doc = await io.readBinary(bytes)
    expect(doc.getRoot().listMeshes().length).toBeGreaterThan(0)
    expect(
      doc
        .getRoot()
        .listExtensionsRequired()
        .some((extension) => extension.extensionName === 'EXT_meshopt_compression'),
    ).toBe(false)
  }
}, 30_000)

it('outfits carry a standardized animated rig and distinct dyeable cloth material', async () => {
  const outfits = CATALOG.filter((item) => item.slot === 'outfit')
  for (const item of outfits) {
    const asset = EQUIPMENT[item.id as keyof typeof EQUIPMENT]
    const doc = await io.read(`public${asset.url.split('?')[0]}`)
    expect(doc.getRoot().listSkins().length).toBe(1)
    expect(
      doc
        .getRoot()
        .listAnimations()
        .map((clip) => clip.getName()),
    ).toContain('Gun_Shoot')
    expect(
      doc
        .getRoot()
        .listMaterials()
        .map((material) => material.getName()),
    ).toContain('Dyeable')
    expect(
      doc
        .getRoot()
        .listMaterials()
        .map((material) => material.getName()),
    ).toContain('Character')
  }
})

it('paired revolvers retain both drawn and holstered bone mounts', async () => {
  const asset = EQUIPMENT['gun.hardins-pair']
  const doc = await io.read(`public${asset.url.split('?')[0]}`)
  const mounts = doc
    .getRoot()
    .listNodes()
    .map((node) => node.getName())
    .filter((name) => name.startsWith('mount.'))
  expect(mounts.sort((a, b) => a.localeCompare(b))).toEqual([
    'mount.UpperLegL.holstered',
    'mount.UpperLegR.holstered',
    'mount.WristL.drawn',
    'mount.WristR.drawn',
  ])
})

it('each paired-gun mount contains one revolver rather than a duplicated preview pair', async () => {
  const asset = EQUIPMENT['gun.hardins-pair']
  const doc = await io.read(`public${asset.url.split('?')[0]}`)
  const mounts = doc
    .getRoot()
    .listNodes()
    .filter((node) => node.getName().startsWith('mount.'))
  const count = (node: ReturnType<typeof doc.createNode>): number =>
    Number(Boolean(node.getMesh())) +
    node.listChildren().reduce((total, child) => total + count(child), 0)
  expect(mounts.map(count)).toEqual([1, 1, 1, 1])
})
