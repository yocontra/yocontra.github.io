/** Legal packed/color/image/morph/Wind input and independent written-stream checks. */
import { type Accessor, Document, type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRMeshQuantization } from '@gltf-transform/extensions'
import { Vec3 } from 'playcanvas'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

function normalWinding(positions: Accessor, normals: Accessor, indices: Accessor): number {
  let minimum = 1
  const point = (vertex: number) =>
    new Vec3().fromArray(positions.getElement(vertex, [] as number[]))
  for (let i = 0; i < indices.getCount(); i += 3) {
    const a = point(indices.getScalar(i))
    const b = point(indices.getScalar(i + 1)).sub(a)
    const c = point(indices.getScalar(i + 2)).sub(a)
    const normal = new Vec3().cross(b, c).normalize()
    for (let j = 0; j < 3; j++) {
      minimum = Math.min(
        minimum,
        normal.dot(
          new Vec3().fromArray(normals.getElement(indices.getScalar(i + j), [] as number[])),
        ),
      )
    }
  }
  return minimum
}

export function ironStreams(node: Node) {
  const p = node.getMesh()?.listPrimitives()[0]
  const positions = p?.getAttribute('POSITION')
  const cloud = p?.getAttribute('TEXCOORD_1')
  const normals = p?.getAttribute('NORMAL')
  const tangents = p?.getAttribute('TANGENT')
  const indices = p?.getIndices()
  if (!(positions && cloud && normals && tangents && indices)) {
    throw new Error('Missing new geometry/cloud UV')
  }
  const bounds = [0, 1, 2].map((axis) => {
    const values = Array.from(
      { length: positions.getCount() },
      (_, i) => positions.getElement(i, [] as number[])[axis] ?? 0,
    )
    return Math.max(...values) - Math.min(...values)
  })
  const cloudExact = Array.from({ length: positions.getCount() }, (_, i) => {
    const [x = 0, , z = 0] = positions.getElement(i, [] as number[])
    const uv = cloud.getElement(i, [] as number[])
    return uv[0] === Math.fround(x / 1024) && uv[1] === Math.fround(z / 1024)
  }).every(Boolean)
  return {
    material: p?.getMaterial()?.getName(),
    finite: [normals, tangents].every((a) => Array.from(a.getArray() ?? []).every(Number.isFinite)),
    matrix: node.getWorldMatrix(),
    minimumNormalDot: normalWinding(positions, normals, indices),
    maximumSpan: Math.max(...bounds),
    cloudExact,
  }
}

export function appendFixture() {
  const fixture = new Document()
  fixture.createExtension(KHRMeshQuantization).setRequired(true)
  const buffer = fixture.createBuffer()
  const texture = fixture
    .createTexture('old embedded image')
    .setMimeType('image/png')
    .setImage(
      new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3,
        2, 0, 239, 163, 11, 169, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ]),
    )
  const material = fixture.createMaterial('Perdition iron').setBaseColorTexture(texture)
  const pos = fixture
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer)
  const color = fixture
    .createAccessor()
    .setType('VEC4')
    .setArray(new Uint16Array(12).fill(32_769))
    .setNormalized(true)
    .setBuffer(buffer)
  const primitive = fixture
    .createPrimitive()
    .setAttribute('POSITION', pos)
    .setAttribute('COLOR_0', color)
    .setMaterial(material)
  const oldAccessor = (
    type: 'VEC2' | 'VEC3' | 'VEC4',
    data: Int16Array<ArrayBuffer> | Float32Array<ArrayBuffer>,
  ) => fixture.createAccessor().setType(type).setArray(data).setBuffer(buffer)
  primitive.setAttribute(
    'NORMAL',
    oldAccessor('VEC3', new Int16Array([0, 0, 32_767, 0, 0, 32_767, 0, 0, 32_767])).setNormalized(
      true,
    ),
  )
  primitive.setAttribute(
    'TANGENT',
    oldAccessor(
      'VEC4',
      new Int16Array([32_767, 0, 0, 32_767, 32_767, 0, 0, 32_767, 32_767, 0, 0, 32_767]),
    ).setNormalized(true),
  )
  primitive.setAttribute('TEXCOORD_0', oldAccessor('VEC2', new Float32Array([0, 0, 1, 0, 0, 1])))
  primitive.setAttribute(
    'TEXCOORD_1',
    oldAccessor('VEC2', new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])),
  )
  primitive.addTarget(
    fixture
      .createPrimitiveTarget()
      .setAttribute(
        'POSITION',
        oldAccessor('VEC3', new Float32Array([0, 0, 0.01, 0, 0, 0, 0, 0, 0])),
      ),
  )
  const node = fixture
    .createNode('old glyph / LOD node')
    .setMesh(fixture.createMesh('old').addPrimitive(primitive))
  fixture.createScene('fixture').addChild(node)
  const windInput = fixture
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Float32Array([0, 1]))
    .setBuffer(buffer)
  const sampler = fixture
    .createAnimationSampler()
    .setInput(windInput)
    .setOutput(oldAccessor('VEC3', new Float32Array([0, 0, 0, 0, 0.01, 0])))
  fixture
    .createAnimation('Wind')
    .addSampler(sampler)
    .addChannel(
      fixture
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath('translation')
        .setSampler(sampler),
    )

  fixture.getRoot().setExtras({ frontierSourceHash: 'a'.repeat(64), other: { untouched: true } })
  return io.writeBinary(fixture)
}
