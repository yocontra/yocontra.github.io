import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

it('the native rifle exports its detailed surface without the canonical alternate LOD', async () => {
  const source = await io.read('tools/art/characters/held-rifle.gltf')
  const native = await io.read('public/experiments/out-west/3d/native-v2/dynamic/held-rifle.glb')
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
  expect(native.getRoot().listMaterials()).toHaveLength(1)
  expect(
    native
      .getRoot()
      .listNodes()
      .some((node) => node.getExtras().lod && node.getMesh()),
  ).toBe(false)
  const sourcePrimitive = original?.getMesh()?.listPrimitives()[0]
  const nativePrimitive = detailed?.getMesh()?.listPrimitives()[0]
  expect(nativePrimitive?.getIndices()?.getCount()).toBe(sourcePrimitive?.getIndices()?.getCount())
  expect(nativePrimitive?.getIndices()?.getCount()).toBe(2904 * 3)
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
