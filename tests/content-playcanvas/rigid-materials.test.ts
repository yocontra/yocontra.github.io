import { expect, test as it } from 'bun:test'
import { Document } from '@gltf-transform/core'
import sharp from 'sharp'
import { consolidateRigidMaterials } from '../../tools/content/rigid-materials.ts'

function fixture() {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]))
    .setBuffer(buffer)
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array([-0.2, 0.1, 1.2, 0.1, 0, 0.8, 0.1, 0.1, 0.8, 0.1, 0.1, 0.8]))
    .setBuffer(buffer)
  const color = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(18).fill(0.7))
    .setBuffer(buffer)
  const mesh = doc.createMesh()
  for (const [index, [metal, rough]] of [
    [0.55, 0.6],
    [0, 0.9],
  ].entries()) {
    const material = doc
      .createMaterial(`Gun ${index}`)
      .setMetallicFactor(metal ?? 0)
      .setRoughnessFactor(rough ?? 1)
      .setExtras({
        nativePbr: { albedo: '/unchanged.color.ktx2', normal: '/unchanged-normal.data.ktx2' },
      })
    mesh.addPrimitive(
      doc
        .createPrimitive()
        .setMaterial(material)
        .setAttribute('POSITION', position)
        .setAttribute('TEXCOORD_0', uv)
        .setAttribute('COLOR_0', color)
        .setIndices(
          doc
            .createAccessor()
            .setType('SCALAR')
            .setArray(Uint16Array.from([0, 1, 2].map((value) => value + index * 3)))
            .setBuffer(buffer),
        ),
    )
  }
  const node = doc
    .createNode('mounted-weapon')
    .setMesh(mesh)
    .setExtras({
      pieceRanges: [
        { start: 0, count: 3, name: 'barrel' },
        { start: 3, count: 3, name: 'grip' },
      ],
    })
  const mount = doc.createNode('mount.WristR.drawn').setTranslation([0.2, 0.3, 0.4]).addChild(node)
  doc.createScene().addChild(mount)
  return { doc, mesh, node, mount, position, uv, color }
}

it('rigid styles become one draw with preserved art, mounts, indices and a linear UV1 rough/metal palette', async () => {
  const source = fixture()
  let image: Uint8Array | undefined
  let colorSpace: boolean | undefined
  await consolidateRigidMaterials(source.doc, (bytes, color) => {
    image = bytes
    colorSpace = color
    return Promise.resolve('/shared-palette.data.ktx2')
  })
  expect(colorSpace).toBe(false)
  expect(source.mesh.listPrimitives()).toHaveLength(1)
  const combined = source.mesh.listPrimitives()[0]
  expect(combined?.getAttribute('POSITION')).toBe(source.position)
  expect(combined?.getAttribute('TEXCOORD_0')).toBe(source.uv)
  expect(combined?.getAttribute('COLOR_0')).toBe(source.color)
  expect(Array.from(combined?.getIndices()?.getArray() ?? [])).toEqual([0, 1, 2, 3, 4, 5])
  expect(source.node.getExtras().pieceRanges).toEqual([
    { start: 0, count: 3, name: 'barrel' },
    { start: 3, count: 3, name: 'grip' },
  ])
  expect(source.mount.getName()).toBe('mount.WristR.drawn')
  expect(source.mount.getTranslation()).toEqual([0.2, 0.3, 0.4])
  expect(combined?.getMaterial()?.getExtras().nativePbr).toEqual({
    albedo: '/unchanged.color.ktx2',
    normal: '/unchanged-normal.data.ktx2',
    arm: '/shared-palette.data.ktx2',
    armUv: 1,
  })
  expect(combined?.getMaterial()?.getMetallicFactor()).toBe(1)
  expect(combined?.getMaterial()?.getRoughnessFactor()).toBe(1)
  if (!image) {
    throw new Error('Palette image was not encoded')
  }
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
  const texcoord = combined?.getAttribute('TEXCOORD_1')
  const pixel = (vertex: number) => {
    const [u = 0, v = 0] = texcoord?.getElement(vertex, []) ?? []
    const offset = (Math.floor(v * info.height) * info.width + Math.floor(u * info.width)) * 4
    return [...data.subarray(offset, offset + 4)]
  }
  expect(pixel(0)).toEqual([255, 153, 140, 255])
  expect(pixel(3)).toEqual([255, 230, 0, 255])
})

it('conflicting shared vertices and existing detail maps are preserved rather than flattened', async () => {
  for (const kind of ['corner', 'arm', 'skin'] as const) {
    const { doc, mesh, node } = fixture()
    if (kind === 'corner') {
      mesh
        .listPrimitives()[1]
        ?.getIndices()
        ?.setArray(Uint16Array.from([0, 4, 5]))
    }
    if (kind === 'arm') {
      for (const primitive of mesh.listPrimitives()) {
        primitive.getMaterial()?.setExtras({
          nativePbr: { albedo: '/unchanged.color.ktx2', arm: '/detailed-original.data.ktx2' },
        })
      }
    }
    if (kind === 'skin') {
      node.setSkin(doc.createSkin().addJoint(doc.createNode('WristR')))
    }
    let encoded = false
    await consolidateRigidMaterials(doc, () => {
      encoded = true
      return Promise.resolve('/unexpected.ktx2')
    })
    expect(encoded).toBe(false)
    expect(mesh.listPrimitives()).toHaveLength(2)
  }
})
