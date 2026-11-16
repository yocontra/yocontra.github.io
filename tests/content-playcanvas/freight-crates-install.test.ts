import { expect, test as it } from 'bun:test'
import { Document } from '@gltf-transform/core'
import { packFreight } from '../../tools/content/freight-crates-contract.ts'
import { installFreightCrates } from '../../tools/content/freight-crates-install.ts'

it('unavailable dimensions require profile regeneration before any document mutation', () => {
  const doc = new Document()
  const sentinel = doc.createNode('unrelated scenery')
  doc.createScene().addChild(sentinel)
  const placements = packFreight([{ kind: 'crates', x: 0, z: 0, w: 1.7, d: 1.1, top: 1.4 }])
  expect(placements.length).toBeGreaterThan(0)
  expect(() =>
    installFreightCrates(
      doc,
      { document: new Document(), prototypes: new Map(), images: [] },
      placements,
    ),
  ).toThrow('regenerate the freight prefab library')
  expect(doc.getRoot().listNodes()).toEqual([sentinel])
  expect(doc.getRoot().listMaterials()).toHaveLength(0)
  expect(doc.getRoot().listMeshes()).toHaveLength(0)
  expect(doc.getRoot().listTextures()).toHaveLength(0)
})
