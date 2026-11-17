import { expect, test as it } from 'bun:test'
import { Document, NodeIO } from '@gltf-transform/core'
import { Mat4, Quat, Vec3 } from 'playcanvas'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'
import { appendBarrelVariants } from '../../tools/content/barrel-install.ts'
import { readMountGlb } from '../../tools/content/frontier-mounts-install.ts'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Invalid fixture')
  }
  return value
}
const io = new NodeIO()
function triangle(doc: Document, size: number, material = doc.createMaterial('Kit')) {
  const buffer = required(doc.getRoot().listBuffers()[0])
  const stream = (type: 'VEC2' | 'VEC3', array: number[]) =>
    doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(array))
  return doc.createMesh().addPrimitive(
    doc
      .createPrimitive()
      .setAttribute('POSITION', stream('VEC3', [0, 0, 0, size, 0, 0, 0, size, 0]))
      .setAttribute('NORMAL', stream('VEC3', [0, 0, 1, 0, 0, 1, 0, 0, 1]))
      .setAttribute('TEXCOORD_0', stream('VEC2', [0, 0, 1, 0, 0, 1]))
      .setAttribute('TEXCOORD_1', stream('VEC2', [0, 0, 0, 0, 0, 0]))
      .setIndices(
        doc
          .createAccessor()
          .setBuffer(buffer)
          .setType('SCALAR')
          .setArray(new Uint16Array([0, 1, 2])),
      )
      .setMaterial(material),
  )
}
async function fixture(native: boolean) {
  const source = new Document()
  const parts = new Document()
  source.createBuffer()
  parts.createBuffer()
  const scene = source.createScene()
  const library = parts.createScene()
  const kit = source.createMaterial('Kit').setBaseColorFactor([0.5, 0.3, 0.1, 1])
  const old = triangle(source, 0.5, kit)
  scene.addChild(source.createNode('Untouched old Kit consumer').setMesh(old))
  for (const prop of ENVIRONMENT_PROPS) {
    const root = source
      .createNode('barrel-instance')
      .setTranslation(prop.binding.translation as [number, number, number])
      .setRotation(prop.binding.rotation as [number, number, number, number])
      .setScale(prop.binding.scale as [number, number, number])
    const pivot = source.createNode('source-pivot').setTranslation([0.001, -0.003, 0.002])
    const mesh = native ? triangle(source, 0.5, kit) : old
    root.addChild(pivot)
    pivot.addChild(source.createNode('barrel_kit').setMesh(mesh))
    scene.addChild(root)
  }
  source.getRoot().setExtras({
    existing: { wind: true },
    ...(native ? { frontierSourceHash: '0'.repeat(64) } : {}),
  })
  library.addChild(parts.createNode('barrel-tall').setMesh(triangle(parts, 1)))
  return { source: await io.writeBinary(source), parts: await io.writeBinary(parts) }
}
it.each([false, true])(
  'raw append preserves all unowned JSON/BIN while replacing exactly eight bindings (native=%s)',
  async (native) => {
    const f = await fixture(native)
    const original = readMountGlb(f.source)
    const bytes = appendBarrelVariants(f.source, f.parts, native ? 'a'.repeat(64) : undefined)
    const output = readMountGlb(bytes)
    expect(output.bin.subarray(0, original.bin.length)).toEqual(original.bin)
    for (const key of [
      'materials',
      'images',
      'textures',
      'samplers',
      'animations',
      'skins',
      'scenes',
      'extensions',
      'extensionsUsed',
    ] as const) {
      expect(output.json[key]).toEqual(original.json[key])
    }
    expect(output.json.nodes).toHaveLength(original.json.nodes.length)
    expect(output.json.accessors.slice(0, original.json.accessors.length)).toEqual(
      original.json.accessors,
    )
    expect(output.json.bufferViews.slice(0, original.json.bufferViews.length)).toEqual(
      original.json.bufferViews,
    )
    const models: number[] = []
    for (const [index, node] of original.json.nodes.entries()) {
      const changed = required(output.json.nodes[index])
      if (node.name === 'barrel-instance') {
        const prop = required(
          ENVIRONMENT_PROPS.find(
            (p) => JSON.stringify(p.binding.translation) === JSON.stringify(node.translation),
          ),
        )
        expect(changed).toEqual({ ...node, name: prop.root, extras: { environmentProp: prop.id } })
      } else if (node.name === 'barrel_kit') {
        expect({ ...changed, mesh: node.mesh }).toEqual({ ...node, mesh: node.mesh })
        models.push(required(changed.mesh))
      } else {
        expect(changed).toEqual(node)
      }
    }
    expect(models).toHaveLength(8)
    expect(new Set(models).size).toBe(native ? 8 : 1)
    expect(output.json.meshes[0]).toEqual(original.json.meshes[0])
    expect(output.json.extras).toEqual({
      ...original.json.extras,
      ...(native ? { frontierSourceHash: 'a'.repeat(64) } : {}),
    })
    const decoded = await io.readBinary(bytes)
    expect(
      decoded
        .getRoot()
        .listNodes()
        .filter((n) => n.getExtras().environmentProp),
    ).toHaveLength(8)
  },
)
it('new native UV1 uses every real ancestor transform and preserves all authored UV0 values', async () => {
  const f = await fixture(true)
  const bytes = appendBarrelVariants(f.source, f.parts, 'a'.repeat(64))
  const output = await io.readBinary(bytes)
  const library = await io.readBinary(f.parts)
  const source = required(library.getRoot().listMeshes()[0]?.listPrimitives()[0])
  for (const prop of ENVIRONMENT_PROPS) {
    const root = required(
      output
        .getRoot()
        .listNodes()
        .find((n) => n.getName() === prop.root),
    )
    const target = required(
      root.listChildren()[0]?.listChildren()[0]?.getMesh()?.listPrimitives()[0],
    )
    expect(target.getAttribute('TEXCOORD_0')?.getArray()).toEqual(
      source.getAttribute('TEXCOORD_0')?.getArray(),
    )
    const matrix = new Mat4()
      .setTRS(
        new Vec3(...prop.binding.translation),
        new Quat(...prop.binding.rotation),
        new Vec3(...prop.binding.scale),
      )
      .mul(new Mat4().setTranslate(0.001, -0.003, 0.002))
    const positions = required(target.getAttribute('POSITION'))
    const uv = required(target.getAttribute('TEXCOORD_1'))
    for (let vertex = 0; vertex < positions.getCount(); vertex++) {
      const xyz = positions.getElement(vertex, [0, 0, 0])
      const p = matrix.transformPoint(new Vec3(...xyz))
      expect(uv.getElement(vertex, [0, 0])).toEqual([
        Math.fround(p.x / 1024),
        Math.fround(p.z / 1024),
      ])
    }
  }
})
it('rejects stale frames, ambiguous bindings and missing authored source instead of rewriting unowned nodes', async () => {
  const f = await fixture(true)
  expect(() => appendBarrelVariants(f.source, f.parts, 'bad')).toThrow('Missing native source link')
  const source = await io.readBinary(f.source)
  const root = source
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'barrel-instance')
  required(root).setTranslation([999, 0, 999])
  const changedBytes = await io.writeBinary(source)
  expect(() => appendBarrelVariants(changedBytes, f.parts, 'a'.repeat(64))).toThrow(
    'Missing unique canonical barrel',
  )
  const duplicateSource = await io.readBinary(f.source)
  const binding = required(ENVIRONMENT_PROPS[0]).binding
  const duplicate = duplicateSource
    .createNode('duplicate')
    .setTranslation(binding.translation as [number, number, number])
    .setRotation(binding.rotation as [number, number, number, number])
    .setScale(binding.scale as [number, number, number])
  required(duplicateSource.getRoot().listScenes()[0]).addChild(duplicate)
  const duplicateBytes = await io.writeBinary(duplicateSource)
  expect(() => appendBarrelVariants(duplicateBytes, f.parts)).toThrow(
    'Missing unique canonical barrel',
  )
  const library = await io.readBinary(f.parts)
  required(library.getRoot().listNodes()[0]).setName('Missing barrel-tall')
  const missingBytes = await io.writeBinary(library)
  expect(() => appendBarrelVariants(f.source, missingBytes)).toThrow('Missing authored tall barrel')
})
