import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const nativeTexture = /\.ktx2$/u
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

it('the native rifle keeps its detailed grip and clips with the authored fore-end and barrel', async () => {
  const source = await io.read('tools/art/characters/held-rifle.gltf')
  const native = await io.read('public/experiments/out-west/3d/native-v2/dynamic/held-rifle.glb')
  const foreparts = await io.read('tools/art/characters/held-surfaces/rifle.glb')
  const alternate = source
    .getRoot()
    .listNodes()
    .find((node) => node.getExtras().lod === true)
  expect(alternate?.getMesh()).toBeTruthy()
  const original = source
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'rifle' && Boolean(node.getMesh()))
  const detailed = native
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'rifle' && Boolean(node.getMesh()))
  expect(native.getRoot().listMeshes()).toHaveLength(1)
  expect(native.getRoot().listMaterials()).toHaveLength(2)
  expect(
    native
      .getRoot()
      .listNodes()
      .some((node) => node.getExtras().lod && node.getMesh()),
  ).toBe(false)
  const sourcePrimitive = original?.getMesh()?.listPrimitives()[0]
  const [replacement, grip] = detailed?.getMesh()?.listPrimitives() ?? []
  const authoredIndices = foreparts
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((total, part) => total + (part.getIndices()?.getCount() ?? 0), 0)
  expect(replacement?.getIndices()?.getCount()).toBe(authoredIndices)
  expect(grip?.getIndices()?.getCount()).toBe(
    (sourcePrimitive?.getIndices()?.getCount() ?? 0) - 336 * 3,
  )
  for (const piece of [replacement, grip]) {
    expect(piece?.getMaterial()?.getName()).toBe('Gun')
    expect(piece?.getMaterial()?.getExtras()?.nativePbr).toMatchObject({
      albedo: expect.stringMatching(nativeTexture),
      normal: expect.stringMatching(nativeTexture),
      arm: expect.stringMatching(nativeTexture),
    })
  }
  expect(
    native
      .getRoot()
      .listNodes()
      .some((node) => node.getName() === 'socket.muzzle'),
  ).toBe(true)
  const actions = await io.read('tools/art/characters/held-actions-rifle.glb')
  for (const clip of actions
    .getRoot()
    .listAnimations()
    .filter((action) => action.getName().startsWith('Weapon_'))) {
    const baked = native
      .getRoot()
      .listAnimations()
      .find((candidate) => candidate.getName() === clip.getName())
    expect(baked).toBeTruthy()
    for (const channel of clip.listChannels()) {
      const matching = baked
        ?.listChannels()
        .find(
          (candidate) =>
            candidate.getTargetNode()?.getName() === channel.getTargetNode()?.getName() &&
            candidate.getTargetPath() === channel.getTargetPath(),
        )
      expect(matching?.getSampler()?.getInput()?.getArray()).toEqual(
        channel.getSampler()?.getInput()?.getArray(),
      )
      expect(matching?.getSampler()?.getOutput()?.getArray()).toEqual(
        channel.getSampler()?.getOutput()?.getArray(),
      )
    }
  }
})
