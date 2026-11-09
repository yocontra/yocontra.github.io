import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
// Full-span panels, identified independently by their world-space bounding boxes.
const panels = new Map([
  ['13.000/16.500/4.200/7.000/-2.600/26.600', 'near-roof'],
  ['16.500/20.600/3.720/7.000/-2.600/26.600', 'far-roof'],
  ['9.300/13.000/3.550/4.200/-2.600/26.600', 'canopy'],
  ['9.300/13.000/3.430/4.080/-2.600/26.600', 'soffit'],
])
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function vertex(primitive: Primitive, id: number, semantics: string[]) {
  return semantics.map((semantic) => {
    const attribute = primitive.getAttribute(semantic)
    if (!attribute) {
      throw new Error(`Missing ${semantic}`)
    }
    const width = attribute.getElementSize()
    return [
      semantic,
      attribute.getComponentType(),
      attribute.getNormalized(),
      Array.from(attribute.getArray()?.slice(id * width, (id + 1) * width) ?? []),
    ]
  })
}

function orientation(primitive: Primitive, ids: number[], points: number[][]) {
  const [a, b, c] = points
  if (!(a && b && c)) {
    throw new Error('Missing roof triangle')
  }
  const ab = b.map((value, axis) => value - (a[axis] ?? 0))
  const ac = c.map((value, axis) => value - (a[axis] ?? 0))
  const geometric = [
    (ab[1] ?? 0) * (ac[2] ?? 0) - (ab[2] ?? 0) * (ac[1] ?? 0),
    (ab[2] ?? 0) * (ac[0] ?? 0) - (ab[0] ?? 0) * (ac[2] ?? 0),
    (ab[0] ?? 0) * (ac[1] ?? 0) - (ab[1] ?? 0) * (ac[0] ?? 0),
  ]
  return {
    geometricY: geometric[1] ?? 0,
    normalAlignment: ids.map((id) => {
      const normal = primitive.getAttribute('NORMAL')?.getElement(id, []) ?? []
      return (
        normal.reduce((sum, value, axis) => sum + value * (geometric[axis] ?? 0), 0) /
        (Math.hypot(...normal) * Math.hypot(...geometric))
      )
    }),
    singleSided: primitive.getMaterial()?.getDoubleSided() === false,
  }
}

async function inspect(bytes: Uint8Array) {
  const document = await io.readBinary(bytes)
  const untouched = createHash('sha256')
  const retained = createHash('sha256')
  const textures = createHash('sha256')
  const faces: ({ panel: string } & ReturnType<typeof orientation>)[] = []
  for (const [meshIndex, mesh] of document.getRoot().listMeshes().entries()) {
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const positions = primitive.getAttribute('POSITION')
      if (!positions) {
        throw new Error('Missing native geometry')
      }
      const indices = primitive.getIndices()
      const count = indices?.getCount() ?? positions.getCount()
      const semantics = primitive.listSemantics().toSorted((a, b) => a.localeCompare(b))
      for (let offset = 0; offset < count; offset += 3) {
        const ids = [0, 1, 2].map(
          (corner) => indices?.getScalar(offset + corner) ?? offset + corner,
        )
        const points = ids.map((id) => positions.getElement(id, []))
        const bounds = [0, 1, 2].flatMap((axis) => [
          Math.min(...points.map((point) => point[axis] ?? 0)),
          Math.max(...points.map((point) => point[axis] ?? 0)),
        ])
        const panel = panels.get(bounds.map((value) => value.toFixed(3)).join('/'))
        const corners = ids.map((id) =>
          vertex(
            primitive,
            id,
            semantics.filter((semantic) => !panel || semantic !== 'NORMAL'),
          ),
        )
        const identity = [
          meshIndex,
          primitiveIndex,
          offset,
          primitive.getMode(),
          primitive.getMaterial()?.getName(),
        ]
        if (!panel) {
          untouched.update(JSON.stringify([identity, corners]))
          continue
        }
        retained.update(
          JSON.stringify([
            identity,
            corners
              .map((corner) => JSON.stringify(corner))
              .toSorted((left, right) => left.localeCompare(right)),
          ]),
        )
        faces.push({ panel, ...orientation(primitive, ids, points) })
      }
    }
  }
  for (const texture of document.getRoot().listTextures()) {
    textures.update(texture.getImage() ?? new Uint8Array())
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    metadata: hash(bytes.slice(20, 20 + view.getUint32(12, true))),
    untouched: untouched.digest('hex'),
    retained: retained.digest('hex'),
    textures: textures.digest('hex'),
    faces,
    animations: document.getRoot().listAnimations().length,
  }
}

for (const [label, path, expected] of [
  [
    'canonical',
    'tools/art/environments/depot.glb',
    {
      metadata: 'ffdf42d599fa494f0237c105fd836109de905c8f902327587a07360e8052eaa4',
      untouched: 'f6b131362ca5d993ffb60f644c7aa2afa9f57b623f714517ba42cba623f79fb5',
      retained: 'a56ff5ba7d958323b4fdfcca8ee11c46ebcd072787a9ed69770681f62d6e530a',
      textures: 'a8ee1d7932b51227c1c43b9609b3b651842f3cc11672daa80f0cf1ab0c410bb8',
    },
  ],
  [
    'native',
    'public/experiments/out-west/3d/native-v2/baked/depot.glb',
    {
      metadata: '8d44c242a15dc3fcac6716007b8a8907e5618659f4696553661a628911941a64',
      untouched: '61a1c7005d46511542976cb4cfc38822afd8b7b59e8c856ac2502fbc0438b1cd',
      retained: '5f51d9da519fde2a7ada2f9892b9189f7a23829e8d1fb0775a85a6009f621b39',
      textures: '491aa699bd3708d03ba0af6455013125e0d8513f7b7f5f2e13875899d9e69a16',
    },
  ],
] as const) {
  it(`${label} depot has outward roofs and a downward boarded soffit, preserving all other art`, async () => {
    const actual = await inspect(await readFile(path))
    expect(actual.faces).toHaveLength(8)
    for (const panel of ['near-roof', 'far-roof', 'canopy', 'soffit']) {
      const selected = actual.faces.filter((face) => face.panel === panel)
      expect(selected).toHaveLength(2)
      const sign = panel === 'soffit' ? -1 : 1
      for (const face of selected) {
        expect(face.geometricY * sign).toBeGreaterThan(0)
        expect(face.normalAlignment.every((dot) => dot > 0.999_99)).toBe(true)
        expect(face.singleSided).toBe(true)
      }
    }
    expect(actual.animations).toBe(0)
    for (const key of ['metadata', 'untouched', 'retained', 'textures'] as const) {
      expect(actual[key]).toBe(expected[key])
    }
  })
}
