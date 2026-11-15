import { expect, test as it } from 'bun:test'
import { type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { getBounds } from '@gltf-transform/functions'
import { FrontierGeometry } from '../../tools/content/frontier-geometry.ts'
import { lodPrefab } from '../../tools/content/model-lod.ts'

it('authored cactus LODs reuse canonical meshes and preserve both variants world placement', async () => {
  const doc = await new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .read('tools/art/environments/frontier-cacti.glb')
  const prototypes = new Map(
    doc
      .getRoot()
      .listScenes()
      .flatMap((scene) =>
        scene.listChildren().map((node) => [node.getName().slice(7), node] as const),
      ),
  )
  const g = Object.create(FrontierGeometry.prototype) as FrontierGeometry
  Reflect.set(g, 'doc', doc)
  Reflect.set(g, 'prototypes', prototypes)
  const root = doc.createNode('test placements')
  doc.createScene().addChild(root)
  const area = { x: 47, z: 62, w: 2, d: 2, y0: 1, top: 5 }
  const fit = { anisotropy: Number.POSITIVE_INFINITY, jitter: Math.PI }
  const near = 'saguaro_two_arm'
  const far = 'saguaro_far_two_arm'
  const nearReference = getBounds(g.prefab(root, near, area, fit))
  const farReference = getBounds(g.prefab(root, far, area, fit))
  const meshes = doc.getRoot().listMeshes().length
  const group = lodPrefab(g, root, area, { near, far, fit })
  expect(group.getName().startsWith('model-lod:28:4:')).toBe(true)
  expect(group.getTranslation()).toEqual([48, 3, 63])
  const high = group.listChildren().find((node) => node.getName().startsWith('lod-near:'))
  const low = group.listChildren().find((node) => node.getName().startsWith('lod-far:'))
  if (!(high && low)) {
    throw new Error('Missing cactus detail variants')
  }
  expect(getBounds(high)).toEqual(nearReference)
  expect(getBounds(low)).toEqual(farReference)
  expect(doc.getRoot().listMeshes().length).toBe(meshes)
  const triangles = (node: Node): number => {
    let total = 0
    node.traverse((child) => {
      for (const primitive of child.getMesh()?.listPrimitives() ?? []) {
        total += (primitive.getIndices()?.getCount() ?? 0) / 3
      }
    })
    return total
  }
  expect(lodPrefab(g, root, area, { near, far, fit }).getName()).not.toBe(group.getName())
  expect(triangles(low)).toBeGreaterThan(0)
  expect(triangles(low)).toBeLessThan(triangles(high))
  expect(() =>
    lodPrefab(g, root, area, { near, far, lod: { distance: 2, hysteresis: 4 } }),
  ).toThrow('Invalid authored')
})
