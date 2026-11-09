import { expect, test as it } from 'bun:test'
import { access } from 'node:fs/promises'
import { getBounds, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const root = 'public/experiments/out-west/3d'
const props = [
  'strongbox',
  'bag0',
  'bag1',
  'bag2',
  'bag3',
  'dynamite',
  'coin',
  'tumbleweed',
  'crow',
]

it('authored native props carry real UVs and shared PBR maps rather than white templates', async () => {
  await Promise.all(
    props.map(async (name) => {
      const doc = await io.read(`${root}/native-v2/dynamic/${name}.glb`)
      const maps: Promise<void>[] = []
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const position = primitive.getAttribute('POSITION')
          const uv = primitive.getAttribute('TEXCOORD_0')
          expect(uv?.getCount()).toBe(position?.getCount())
          expect(uv?.getMin([]).every(Number.isFinite)).toBe(true)
          expect(uv?.getMax([]).every(Number.isFinite)).toBe(true)
          const pbr = primitive.getMaterial()?.getExtras().nativePbr as {
            albedo: string
            normal: string
            arm: string
            ao: boolean
          }
          expect(pbr.ao).toBe(true)
          maps.push(
            ...[pbr.albedo, pbr.normal, pbr.arm].map(async (url) => {
              expect(url.endsWith('.ktx2')).toBe(true)
              await access(`public${url}`)
            }),
          )
        }
      }
      await Promise.all(maps)
    }),
  )
})

it('detailed Kit replacements retain natural uniform proportions inside existing gameplay bounds', async () => {
  await Promise.all(
    ['strongbox', 'bag0', 'bag1', 'bag2', 'bag3', 'dynamite'].map(async (name) => {
      const [old, current] = await Promise.all([
        io.read(`${root}/dynamic/${name}.glb`),
        io.read(`${root}/native-v2/dynamic/${name}.glb`),
      ])
      const oldScene = old.getRoot().listScenes()[0]
      const newScene = current.getRoot().listScenes()[0]
      if (!(oldScene && newScene)) {
        throw new Error('Missing prop scene')
      }
      const before = getBounds(oldScene)
      const after = getBounds(newScene)
      for (let axis = 0; axis < 3; axis++) {
        expect(after.min[axis]).toBeGreaterThanOrEqual((before.min[axis] ?? 0) - 0.001)
        expect(after.max[axis]).toBeLessThanOrEqual((before.max[axis] ?? 0) + 0.001)
      }
      const scale = current
        .getRoot()
        .listNodes()
        .find((n) => n.getName() === `detail.${name}`)
        ?.getScale()
      expect(scale?.[0]).toBe(scale?.[1])
      expect(scale?.[1]).toBe(scale?.[2])
    }),
  )
})

it('the legacy three-second crow cue and ambient flight keep their distinct authored timing', async () => {
  const duration = async (path: string, clip: string) => {
    const doc = await io.read(path)
    const animation = doc
      .getRoot()
      .listAnimations()
      .find((a) => a.getName() === clip)
    return Math.max(
      ...(animation?.listSamplers().map((s) => s.getInput()?.getMax([])[0] ?? 0) ?? []),
    )
  }
  expect(await duration(`${root}/native-v2/dynamic/crow.glb`, 'Gun_Shoot')).toBe(3)
  expect(await duration(`${root}/native-v2/ambient/crow.glb`, 'Fly')).toBe(2)
  expect(await duration(`${root}/native-v2/ambient/crow.glb`, 'Gun_Shoot')).toBe(2)
})

it('coin face UVs use mesh bounds rather than the scaled world-space diameter', async () => {
  const doc = await io.read(`${root}/native-v2/dynamic/coin.glb`)
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const uv = primitive.getAttribute('TEXCOORD_0')
      expect(uv?.getMin([]).every((v) => v >= 0)).toBe(true)
      expect(uv?.getMax([]).every((v) => v <= 1)).toBe(true)
    }
  }
})
