import { expect, test as it } from 'bun:test'
import { Document } from '@gltf-transform/core'
import { dedup, dequantize, prune, weld } from '@gltf-transform/functions'
import {
  authorEnvironmentCloudUvs,
  restoreFreightUv1Usage,
  retainFreightUv1,
} from '../../tools/content/environment-cloud-uvs.ts'
import {
  packFrontierCloudUvs,
  packFrontierVertices,
} from '../../tools/content/frontier-vertex-packing.ts'

function fixture(names: string[]) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const mesh = doc.createMesh('shared fixture')
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]))
    .setBuffer(buffer)
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 0.001, 0, 0, 0.001]))
    .setBuffer(buffer)
  for (const name of names) {
    mesh.addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', positions)
        .setAttribute('TEXCOORD_1', uv)
        .setMaterial(
          doc
            .createMaterial(name)
            .setExtras(name === 'Freight scanned atlas' ? { freightWorldUv1: true } : {}),
        ),
    )
  }
  const a = doc.createNode('a').setMesh(mesh).setTranslation([10, 0, 20])
  const b = doc.createNode('b').setMesh(mesh).setTranslation([30, 0, 40])
  doc.createScene().addChild(a).addChild(b)
  return { doc, mesh, uv, a, b }
}

it('Frontier freight keeps shared meshes and the exact local UV1 accessor', () => {
  const { doc, mesh, uv, a, b } = fixture(['Freight scanned atlas', 'Freight scanned atlas'])
  const before = Array.from(uv.getArray() ?? [])
  authorEnvironmentCloudUvs(doc, 'frontier')
  expect(a.getMesh()).toBe(mesh)
  expect(b.getMesh()).toBe(mesh)
  expect(doc.getRoot().listMeshes()).toHaveLength(1)
  for (const primitive of mesh.listPrimitives()) {
    expect(primitive.getAttribute('TEXCOORD_1')).toBe(uv)
  }
  expect(Array.from(uv.getArray() ?? [])).toEqual(before)
})

it('ordinary and mixed-material Frontier meshes still get distinct world-UV meshes', () => {
  for (const names of [['wood'], ['Freight scanned atlas', 'wood']]) {
    const { doc, mesh, uv, a, b } = fixture(names)
    authorEnvironmentCloudUvs(doc, 'frontier')
    expect(a.getMesh()).not.toBe(mesh)
    expect(b.getMesh()).not.toBe(a.getMesh())
    for (const node of [a, b]) {
      const expected = node.getTranslation()
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        const actual = primitive.getAttribute('TEXCOORD_1')
        expect(actual).not.toBe(uv)
        expect(actual?.getElement(0, [0, 0])).toEqual([expected[0] / 1024, expected[2] / 1024])
      }
    }
  }
  const { doc, mesh, a, b } = fixture(['Freight scanned atlas'])
  mesh.listPrimitives()[0]?.getMaterial()?.setExtras({})
  authorEnvironmentCloudUvs(doc, 'frontier')
  expect(a.getMesh()).not.toBe(mesh)
  expect(b.getMesh()).not.toBe(a.getMesh())
})

it('missing freight UV1 fails instead of silently disabling its native shader feature', () => {
  const { doc, mesh, a, b } = fixture(['Freight scanned atlas'])
  mesh.listPrimitives()[0]?.setAttribute('TEXCOORD_1', null)
  expect(() => authorEnvironmentCloudUvs(doc, 'frontier')).toThrow('require authored UV1')
  expect(a.getMesh()).toBe(mesh)
  expect(b.getMesh()).toBe(mesh)
})

it('duel ground keeps its existing normalized arena UV formula', () => {
  const { doc, a, b } = fixture(['ground'])
  b.dispose()
  a.setName('ground-fixture')
  authorEnvironmentCloudUvs(doc, 'duel')
  expect(
    a.getMesh()?.listPrimitives()[0]?.getAttribute('TEXCOORD_1')?.getElement(0, [0, 0]),
  ).toEqual([26 / 32, 90 / 128])
})

it('stock native optimizers retain shared freight UV1 and final map usage returns exactly to UV0', async () => {
  const { doc, a, b, uv } = fixture(['Freight scanned atlas'])
  const original = Array.from(uv.getArray() ?? [])
  const texture = doc
    .createTexture()
    .setImage(new Uint8Array([1, 2, 3]))
    .setMimeType('image/png')
  const material = doc.getRoot().listMaterials()[0]
  if (!material) {
    throw new Error('Missing fixture material')
  }
  material.setName('typed-marker fixture').setExtras({ freightWorldUv1: true, retained: 42 })
  material.setBaseColorTexture(texture).setOcclusionTexture(texture)
  for (const primitive of a.getMesh()?.listPrimitives() ?? []) {
    primitive.setAttribute('TEXCOORD_0', uv)
  }
  retainFreightUv1(doc)
  expect(material.getOcclusionTextureInfo()?.getTexCoord()).toBe(1)
  await doc.transform(dedup(), weld(), prune(), dequantize())
  restoreFreightUv1Usage(doc)
  authorEnvironmentCloudUvs(doc, 'frontier')
  await packFrontierVertices(doc)
  expect(a.getMesh()).toBe(b.getMesh())
  expect(
    Array.from(a.getMesh()?.listPrimitives()[0]?.getAttribute('TEXCOORD_1')?.getArray() ?? []),
  ).toEqual(original)
  expect(material.getOcclusionTextureInfo()?.getTexCoord()).toBe(0)
  expect(material.getBaseColorTextureInfo()?.getTexCoord()).toBe(0)
  expect(material.getExtras()).toEqual({ freightWorldUv1: true, retained: 42 })
})

it('packs cloud UVs within the world projection tolerance and leaves freight UVs exact', () => {
  const { doc, mesh, uv, a } = fixture(['Freight scanned atlas'])
  a.setTranslation([-10, 0, 20])
  const wood = doc
    .createPrimitive()
    .setAttribute('POSITION', mesh.listPrimitives()[0]?.getAttribute('POSITION') ?? null)
    .setAttribute('TEXCOORD_0', uv)
  const below = doc
    .createNode('cloud fixture')
    .setTranslation([-10, 0, 20])
    .setMesh(doc.createMesh().addPrimitive(wood))
  doc.getRoot().listScenes()[0]?.addChild(below)
  authorEnvironmentCloudUvs(doc, 'frontier')
  const primitive = below.getMesh()?.listPrimitives()[0]
  const projected = primitive?.getAttribute('TEXCOORD_1')
  if (!projected) {
    throw new Error('Missing authored cloud UV projection')
  }
  const sample = projected.getElement(0, [])
  expect(packFrontierCloudUvs(doc)).toBe(12)
  expect(projected.getArray()).toBeInstanceOf(Int16Array)
  expect(projected.getNormalized()).toBe(true)
  expect(Math.abs((projected.getElement(0, [])[0] ?? 0) - (sample[0] ?? 0))).toBeLessThan(0.000_016)
  expect(primitive?.getAttribute('TEXCOORD_0')).toBe(uv)
  expect(uv.getArray()).toBeInstanceOf(Float32Array)
  expect(mesh.listPrimitives()[0]?.getAttribute('TEXCOORD_1')).toBe(uv)
})
