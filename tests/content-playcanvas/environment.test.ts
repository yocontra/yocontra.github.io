import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { AMBIENT_ASSETS } from '../../src/experiments/out-west/content/ambient.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import streetLife from '../../src/experiments/out-west/content/street-life.json' with {
  type: 'json',
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

it('environment PBR maps use native Basis images and preserve the complete vegetation pass', async () => {
  const documents = await Promise.all(
    (['frontier', 'duel', 'depot', 'mission', 'bank'] as const).map((name) =>
      io.read(`public${ASSETS[name].url.split('?')[0]}`),
    ),
  )
  for (const document of documents) {
    const root = document.getRoot()
    expect(root.listMaterials().some((material) => material.getName() === 'Civic')).toBe(false)
    expect(
      root
        .listMaterials()
        .filter((material) => material.getName().startsWith('Masonry-'))
        .every(
          (material) => material.getOcclusionTexture() === material.getMetallicRoughnessTexture(),
        ),
    ).toBe(true)
    expect(root.listTextures().every((texture) => texture.getMimeType() === 'image/ktx2')).toBe(
      true,
    )
    expect(
      root
        .listExtensionsRequired()
        .some((extension) => extension.extensionName === 'KHR_texture_basisu'),
    ).toBe(true)
  }
  const frontier = documents[0]?.getRoot()
  expect(frontier?.listNodes().some((node) => node.getName().startsWith('far-'))).toBe(false)
  expect(
    frontier?.listNodes().filter((node) => node.getName().startsWith('flora-')).length,
  ).toBeGreaterThan(0)
  expect(frontier?.listAnimations().map((animation) => animation.getName())).toContain('Wind')
  const authored = JSON.parse(await readFile('tools/art/environments/frontier.json', 'utf8')) as {
    panes: number
    arrival: number[]
    life: { folk: unknown[]; horses: unknown[]; crowPerches: unknown[] }
  }
  expect(frontier?.listNodes().filter((node) => node.getName().startsWith('flora-'))).toHaveLength(
    19,
  )
  expect(authored.panes).toBe(241)
  expect(authored.arrival).toEqual([52, 0, 52])
  expect(authored.life.folk).toHaveLength(2)
  expect(authored.life.horses).toHaveLength(1)
  expect(authored.life.crowPerches).toHaveLength(3)
  expect(streetLife.folk).toHaveLength(9)
  expect(streetLife.horses).toHaveLength(2)
}, 30_000)

it('the wanted paper retains UVs and its original placement rather than appearing at the duel origin', async () => {
  const document = await io.read(`public${ASSETS.duel.url.split('?')[0]}`)
  const node = document
    .getRoot()
    .listNodes()
    .find((candidate) =>
      candidate
        .getMesh()
        ?.listPrimitives()
        .some((primitive) => primitive.getMaterial()?.getName() === 'WantedPaper'),
    )
  expect(node).toBeDefined()
  const paper = node?.getMesh()?.listPrimitives()[0]
  expect(paper?.getAttribute('TEXCOORD_0')?.getCount()).toBeGreaterThan(0)
  expect(paper?.getMaterial()?.getBaseColorTexture()).toBeTruthy()
  const matrix = node?.getWorldMatrix()
  expect(matrix?.[12]).toBeCloseTo(-8.08, 1)
  expect(matrix?.[13]).toBeCloseTo(1.75, 1)
  expect(matrix?.[14]).toBeCloseTo(-2.5, 1)
})

it('ambient native clips and textures match their generated content hashes', async () => {
  await Promise.all(
    Object.values(AMBIENT_ASSETS).map(async (asset) => {
      const bytes = await readFile(`public${asset.url.split('?')[0]}`)
      expect(bytes.length).toBe(asset.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.hash)
    }),
  )
  const document = await io.read(`public${AMBIENT_ASSETS.clockwork.url.split('?')[0]}`)
  const clips = document
    .getRoot()
    .listAnimations()
    .map((animation) => animation.getName())
  expect(clips).toContain('Clock_11_59')
  expect(clips).toContain('Toll')
  expect(document.getRoot().listMeshes()).toHaveLength(2)
  expect(document.getRoot().listSkins().length).toBeGreaterThan(0)
  expect(
    document
      .getRoot()
      .listSkins()
      .every((skin) => skin.listJoints().length === 9),
  ).toBe(true)
})
