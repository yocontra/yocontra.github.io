import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Document, type Node, NodeIO } from '@gltf-transform/core'
import { mergeDocuments } from '@gltf-transform/functions'
import { spawnSync } from 'bun'
import {
  FREIGHT_UV_PRECISION,
  type FreightCell,
  type FreightCover,
  type FreightSourceUv,
  matchFreightUvValues,
  type Point,
  packFreight,
  rayHit,
  requireClosedFreight,
  requireFreightEnvelope,
  requireFreightUv0,
  triangles,
} from '../../tools/content/freight-crates-contract.ts'
import {
  checkFreightPlacement,
  cleanupFreightResources,
  freightContactCoordinate,
  freightResourceBaseline,
  inspectFreightResources,
  removeTree,
  treeDigest,
} from '../../tools/content/freight-crates-geometry.ts'
import { replaceFreightPlacement } from '../../tools/content/freight-crates-install.ts'
import {
  bakeFreightPositions,
  createFreightMaterial,
  freightArtifactBudget,
  prepareFreightPrototypes,
  requireFreightReadback,
} from '../../tools/content/freight-crates-library.ts'

const plan = JSON.parse(await readFile('tools/art/environments/frontier.plan.json', 'utf8')) as {
  layout: { cover: FreightCover[] }
}

function hitBoxes(
  boxes: Pick<FreightCell, 'min' | 'max'>[],
  origin: Point,
  direction: Point,
): number | null {
  let nearest = Number.POSITIVE_INFINITY
  for (const box of boxes) {
    let lower = 0
    let upper = Number.POSITIVE_INFINITY
    for (let axis = 0; axis < 3; axis++) {
      const position = origin[axis] ?? 0
      const velocity = direction[axis] ?? 0
      const min = box.min[axis] ?? 0
      const max = box.max[axis] ?? 0
      if (velocity === 0) {
        if (position < min || position > max) {
          upper = -1
        }
      } else {
        const a = (min - position) / velocity
        const b = (max - position) / velocity
        lower = Math.max(lower, Math.min(a, b))
        upper = Math.min(upper, Math.max(a, b))
      }
    }
    if (upper >= lower && upper >= 0) {
      nearest = Math.min(nearest, lower)
    }
  }
  return Number.isFinite(nearest) ? nearest : null
}

it('all 44 freight covers get complete support and visible perimeter cells', () => {
  const packed = packFreight(plan.layout.cover)
  expect(packed).toHaveLength(44)
  for (const group of packed) {
    const cover = plan.layout.cover[group.coverIndex]
    if (!cover) {
      throw new Error('Missing freight cover')
    }
    expect(group.min).toEqual([cover.x, cover.y0 ?? 0, cover.z])
    expect(group.max).toEqual([cover.x + cover.w, cover.top ?? 1, cover.z + cover.d])
    for (const cell of group.cells) {
      for (let axis = 0; axis < 3; axis++) {
        expect(cell.min[axis]).toBeGreaterThanOrEqual((group.min[axis] ?? 0) - 1e-9)
        expect(cell.max[axis]).toBeLessThanOrEqual((group.max[axis] ?? 0) + 1e-9)
      }
      expect(cell.dimensions.every((dimension) => dimension >= 0.6 && dimension <= 1.5)).toBe(true)
    }
    const result = requireFreightEnvelope(group, group, (origin, direction) =>
      hitBoxes(group.cells, origin, direction),
    )
    expect(result.maximumContactError).toBeLessThan(1e-9)
  }
})

it('covers 221/184/227 reach their real lids without protruding', () => {
  const packed = packFreight(plan.layout.cover)
  for (const index of [221, 184, 227]) {
    const group = packed.find((entry) => entry.coverIndex === index)
    if (!group) {
      throw new Error(`Missing regression freight cover ${index}`)
    }
    const lid = group.cells.filter((cell) => Math.abs(cell.max[1] - group.max[1]) < 1e-8)
    const area = lid.reduce((sum, cell) => sum + cell.dimensions[0] * cell.dimensions[2], 0)
    expect(area).toBeCloseTo((group.max[0] - group.min[0]) * (group.max[2] - group.min[2]), 9)
  }
})

it('an outer AABB cannot conceal air, an invisible lid or a large side recess', () => {
  const envelope = { min: [0, 0, 0] as Point, max: [1, 1, 1] as Point }
  expect(() => requireFreightEnvelope(envelope, envelope, () => null)).toThrow('contact')
  expect(() =>
    requireFreightEnvelope(envelope, envelope, (_origin, direction) =>
      direction[1] === 0 ? 0.131 : 0.1,
    ),
  ).toThrow('contact')
  expect(() =>
    requireFreightEnvelope(envelope, envelope, (_origin, direction) =>
      direction[1] === 0 ? 0.1 : 0.3059,
    ),
  ).toThrow('contact')
  expect(() =>
    requireFreightEnvelope(envelope, { ...envelope, max: [1.0262, 1, 1] }, () => 0.1),
  ).toThrow('envelope')
  expect(
    requireFreightEnvelope(envelope, envelope, (_origin, direction) =>
      direction[1] === 0 ? 0.125 : 0.1,
    ).maximumSideRecess,
  ).toBeCloseTo(0.025)
})

it('invalid covers fail before authoring; other props remain outside this packing scope', () => {
  expect(packFreight([{ kind: 'barrels', x: 0, z: 0, w: 1, d: 1, top: 1 }])).toEqual([])
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => packFreight([{ kind: 'crates', x: 0, z: 0, w: value, d: 1, top: 1 }])).toThrow(
      'Invalid',
    )
  }
})

it('body validation rejects open cover planes and accepts a closed tetrahedron', () => {
  const a: Point = [0, 0, 0]
  const b: Point = [1, 0, 0]
  const c: Point = [0, 1, 0]
  const d: Point = [0, 0, 1]
  expect(() => requireClosedFreight([[a, b, c]])).toThrow('closed')
  expect(() =>
    requireClosedFreight([
      [a, b, c],
      [a, d, b],
      [a, c, d],
      [b, d, c],
    ]),
  ).not.toThrow()
})

it('contact rays hit actual triangles, including the reverse winding, and reject misses', () => {
  const a: Point = [0, 0, 0]
  const b: Point = [1, 0, 0]
  const c: Point = [0, 1, 0]
  expect(rayHit([[a, b, c]], [0.25, 0.25, 1], [0, 0, -1])).toBeCloseTo(1)
  expect(rayHit([[c, b, a]], [0.25, 0.25, 1], [0, 0, -1])).toBeCloseTo(1)
  expect(rayHit([[a, b, c]], [2, 2, 1], [0, 0, -1])).toBeNull()
  expect(rayHit([[a, b, c]], [0.25, 0.25, 1], [0, 0, 1])).toBeNull()
  expect(rayHit([[a, b, c]], [0.25, 0.25, 1], [1, 0, 0])).toBeNull()
})

function solid(doc: Document, min: Point, max: Point, role = 'body') {
  const positions = Float32Array.from(
    [
      min,
      [max[0], min[1], min[2]],
      [max[0], max[1], min[2]],
      [min[0], max[1], min[2]],
      [min[0], min[1], max[2]],
      [max[0], min[1], max[2]],
      max,
      [min[0], max[1], max[2]],
    ].flat(),
  )
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const attribute = (type: 'VEC2' | 'VEC3' | 'VEC4', values: Float32Array<ArrayBuffer>) =>
    doc.createAccessor().setType(type).setArray(values).setBuffer(buffer)
  const normals = Float32Array.from({ length: 24 }, (_, i) => (i % 3 === 1 ? 1 : 0))
  const tangents = Float32Array.from({ length: 32 }, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 1 : 0))
  const uv = Float32Array.from({ length: 16 }, (_, i) => i / 16)
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2,
    6, 1, 6, 5,
  ])
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', attribute('VEC3', positions))
    .setAttribute('NORMAL', attribute('VEC3', normals))
    .setAttribute('TANGENT', attribute('VEC4', tangents))
    .setAttribute('TEXCOORD_0', attribute('VEC2', uv))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
  return doc
    .createNode(`source-${role}`)
    .setMesh(doc.createMesh().addPrimitive(primitive))
    .setExtras({ freightRole: role })
}

async function reuseFixture(outer = 0.5) {
  const library = new Document()
  const libraryScene = library.createScene()
  for (const tier of ['near', 'far']) {
    const root = library
      .createNode(`freight:fixture:${tier}`)
      .setExtras({ freightJointPlanes: '[[1,1,0,0]]' })
    root.addChild(solid(library, [-outer, 0, -0.5], [0, 1, 0.5]))
    root.addChild(solid(library, [0, 0, -0.5], [outer, 1, 0.5]))
    root.addChild(solid(library, [-0.01, 0.1, -0.01], [0.01, 0.11, 0.01], 'hardware'))
    libraryScene.addChild(root)
  }
  const prototypes = await prepareFreightPrototypes(library)
  const doc = new Document()
  const scene = doc.createScene()
  const parent = doc.createNode('environment')
  scene.addChild(parent)
  const original = doc.createNode('k_crate_big-placement')
  original.addChild(solid(doc, [10, 0, 20], [12, 1, 21]))
  parent.addChild(original)
  const protectedNode = solid(doc, [-3, 0, -3], [-2, 1, -2])
  protectedNode.setName('unselected')
  parent.addChild(protectedNode)
  const originalResources = freightResourceBaseline(doc)
  const protectedDigest = treeDigest(protectedNode)
  const io = new NodeIO()
  const before = await io.readBinary(await io.writeBinary(doc))
  const merged = mergeDocuments(doc, library)
  const templates = new Map(
    library
      .getRoot()
      .listNodes()
      .map((n) => [n.getName(), merged.get(n) as Node]),
  )
  const material = createFreightMaterial(doc, [
    Buffer.from([1]),
    Buffer.from([2]),
    Buffer.from([3]),
  ])
  const cells = [0, 1].map((x) => ({
    id: `0:${x}:0:0`,
    coverIndex: 0,
    family: 'shipping' as const,
    min: [10 + x, 0, 20] as Point,
    max: [11 + x, 1, 21] as Point,
    dimensions: [1, 1, 1] as Point,
    model: 'fixture',
  }))
  const placement = {
    coverIndex: 0,
    min: [10, 0, 20] as Point,
    max: [12, 1, 21] as Point,
    counts: [2, 1, 1] as Point,
    cells,
  }
  const checks = replaceFreightPlacement(
    { doc, templates, material, prototypes },
    placement,
    original,
  )
  const group = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName().endsWith(':freight-0'))
  const branch = group?.listChildren()[0]
  if (!(group && branch)) {
    throw new Error('Missing native reuse fixture')
  }
  return {
    doc,
    io,
    before,
    placement,
    checks,
    group,
    branch,
    prototypes,
    protectedNode,
    protectedDigest,
    originalResources,
  }
}
function body(cell: Node) {
  const result = cell
    .listChildren()[0]
    ?.listChildren()
    .find((n) => n.getExtras().freightRole === 'body')
  if (!result?.getMesh()) {
    throw new Error('Missing real freight body')
  }
  return result
}
it('shared prototypes preserve local streams; position fallback retains every invariant reference', async () => {
  const f = await reuseFixture()
  expect(
    f.checks.every((c) => c.representation === 'shared-prototype' && c.fallbackReason === null),
  ).toBe(true)
  const instances = f.branch.listChildren()
  const first = instances[0]
  const second = instances[1]
  if (!(first && second)) {
    throw new Error('Missing repeated cases')
  }
  const source = body(first).getMesh()?.listPrimitives()[0]
  expect(body(first).getMesh()).toBe(body(second).getMesh())
  expect(first.getTranslation()).not.toEqual(second.getTranslation())
  expect(source?.getAttribute('TEXCOORD_1')).not.toBeNull()
  const proto = f.prototypes.get('freight:fixture:near')
  if (!(proto && source)) {
    throw new Error('Missing prototype provenance')
  }
  const cells = f.placement.cells.map((cell) => ({
    cell: cell.id,
    prototype: 'freight:fixture:near',
    ...proto,
  }))
  bakeFreightPositions(f.doc, f.branch, f.placement, cells)
  const moved = body(first).getMesh()?.listPrimitives()[0]
  expect(moved?.getAttribute('POSITION')).not.toBe(source.getAttribute('POSITION'))
  for (const semantic of ['NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1']) {
    expect(moved?.getAttribute(semantic)).toBe(source.getAttribute(semantic))
  }
  expect(moved?.getIndices()).toBe(source.getIndices())
  expect(first.getTranslation()).toEqual([0, 0, 0])
  expect(
    checkFreightPlacement(f.placement, f.branch, 'near', cells).maximumContactError,
  ).toBeLessThan(1e-9)
  expect(treeDigest(f.protectedNode)).toBe(f.protectedDigest)
  for (const node of f.doc
    .getRoot()
    .listNodes()
    .filter((n) => n.getName().startsWith('freight:') && n.getParentNode() === null)) {
    removeTree(node)
  }
  for (const scene of f.doc.getRoot().listScenes().slice(1)) {
    scene.dispose()
  }
  const resources = cleanupFreightResources(f.doc, f.originalResources)
  const buffer = f.doc.getRoot().listBuffers()[0] ?? f.doc.createBuffer()
  for (const accessor of f.doc.getRoot().listAccessors()) {
    accessor.setBuffer(buffer)
  }
  for (const extra of f.doc.getRoot().listBuffers().slice(1)) {
    extra.dispose()
  }
  const bytes = await f.io.writeBinary(f.doc)
  const decoded = await f.io.readBinary(bytes)
  expect(inspectFreightResources(decoded)).toEqual(resources)
  expect(
    requireFreightReadback(f.before, decoded, { placements: [f.placement], selected: [0] })
      .unaffectedNodes,
  ).toBe(2)
  decoded
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'unselected')
    ?.setTranslation([0.01, 0, 0])
  expect(() =>
    requireFreightReadback(f.before, decoded, { placements: [f.placement], selected: [0] }),
  ).toThrow('Unowned')
})
it('only an actual joint-ray failure triggers fallback; beyond-micron holes remain failures', async () => {
  const f = await reuseFixture(0.5 - 2 ** -24)
  expect(
    f.checks.every(
      (c) => c.representation === 'baked-position' && c.fallbackReason?.includes('contact'),
    ),
  ).toBe(true)
  expect(f.checks.every((c) => c.jointContact.maximumContactError < 0.001)).toBe(true)
  expect(f.checks.every((c) => c.maximumSeamCorrection <= 0.000_001)).toBe(true)
  await expect(reuseFixture(0.498)).rejects.toThrow('Freight')
})
it('Pages budget uses actual native byte growth and enforces the strict one-billion-byte cap', () => {
  expect(freightArtifactBudget(965_924_572, 36_264_120, 61_021_288).projectedBytes).toBe(
    990_681_740,
  )
  expect(() => freightArtifactBudget(999_999_999, 1, 2)).toThrow('Pages budget')
  expect(() => freightArtifactBudget(0, 1, 1)).toThrow('actual')
})

it('only micron-scale contact coordinates are snapped; a physical gap remains a failure', () => {
  expect(freightContactCoordinate(0.374_999_996_274_709_7, [0.375])).toBe(0.375)
  expect(freightContactCoordinate(0.3735, [0.375])).toBe(Math.fround(0.3735))
  const doc = new Document()
  const root = doc.createNode('broken-lid')
  root.addChild(solid(doc, [0, 0, 0], [0.499, 1, 1]))
  root.addChild(solid(doc, [0.501, 0, 0], [1, 1, 1]))
  expect(rayHit(triangles(root, false), [0.5, 1.1, 0.5], [0, -1, 0])).toBeNull()
  const envelope = { min: [0, 0, 0] as Point, max: [1, 1, 1] as Point }
  expect(() =>
    requireFreightEnvelope(envelope, envelope, (origin, direction) =>
      rayHit(triangles(root, false), origin, direction),
    ),
  ).toThrow('contact')
})

it('authored UV0 guard rejects the old default-plus-authored-UV1 layout and coordinate mutations', () => {
  const doc = new Document()
  const node = solid(doc, [0, 0, 0], [1, 1, 1])
  const primitive = node.getMesh()?.listPrimitives()[0]
  const uv = primitive?.getAttribute('TEXCOORD_0')
  if (!(primitive && uv)) {
    throw new Error('Missing UV regression fixture')
  }
  const pairs = Array.from({ length: 8 }, (_, i) => {
    const bytes = Buffer.alloc(8)
    bytes.writeFloatLE((i * 2) / 16, 0)
    bytes.writeFloatLE((i * 2 + 1) / 16, 4)
    return bytes.toString('hex')
  })
  const expected: FreightSourceUv[] = [
    {
      name: node.getName(),
      uv0UniqueValues: 8,
      uv0Values: pairs.map(
        (hex) =>
          [Buffer.from(hex, 'hex').readFloatLE(0), Buffer.from(hex, 'hex').readFloatLE(4)] as [
            number,
            number,
          ],
      ),
      uv0ValueSetSHA256: createHash('sha256')
        .update(pairs.sort((a, b) => a.localeCompare(b, 'en')).join('\n'))
        .digest('hex'),
    },
  ]
  expect(requireFreightUv0(doc, expected).pieces).toBe(1)
  primitive.setAttribute('TEXCOORD_1', uv.clone())
  expect(() => requireFreightUv0(doc, expected)).toThrow('authored UV0 only')
  primitive.setAttribute('TEXCOORD_1', null)
  uv.setElement(0, [0.75, 0.0625])
  expect(() => requireFreightUv0(doc, expected)).toThrow('authored UV0 differs')
  primitive.setAttribute('TEXCOORD_0', null)
  expect(() => requireFreightUv0(doc, expected)).toThrow('authored UV0 only')
})

it('UV precision accepts the measured floor pair, rejects beyond-bound/missing data, and matches ambiguous values one-to-one', () => {
  const source: [number, number] = [0.520_233_392_715_454_1, 0.904_999_971_389_770_5]
  const exported: [number, number] = [0.520_233_333_110_809_3, 0.904_999_971_389_770_5]
  expect(matchFreightUvValues([source], [exported]).maximumComponentError).toBe(
    FREIGHT_UV_PRECISION,
  )
  expect(() =>
    matchFreightUvValues([source], [[source[0] + FREIGHT_UV_PRECISION * 2, source[1]]]),
  ).toThrow('precision bound')
  expect(() => matchFreightUvValues([source], [])).toThrow('cardinality')
  const result = matchFreightUvValues(
    [
      [FREIGHT_UV_PRECISION, 0],
      [0, 0],
    ],
    [
      [FREIGHT_UV_PRECISION / 2, 0],
      [FREIGHT_UV_PRECISION * 2, 0],
    ],
  )
  expect(result.matches.map((match) => match.source).sort((a, b) => a - b)).toEqual([0, 1])
  expect(result.ambiguousValues).toBe(1)
  expect(result.maximumComponentError).toBe(FREIGHT_UV_PRECISION)
})

it('the actual Python UV author maps a continuous metred stamp and independent timber crops', () => {
  const result = spawnSync([
    'python3',
    '-c',
    `
import ast,json
from collections import namedtuple
from pathlib import Path
from types import SimpleNamespace as NS
source=ast.parse(Path('tools/content/freight-crates-authoring.py').read_text())
items=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='uv_box']
items += [n for n in source.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='STRIPS' for t in n.targets)]
scope={};exec(compile(ast.Module(body=items,type_ignores=[]),'actual-uv-author','exec'),scope)
V=namedtuple('V','x y z')
def mapped(name,points,size,index=0,offset=(0,0,0),stamp=False):
 layer=NS(data=[NS(uv=None) for p in points])
 mesh=NS(uv_layers=NS(active=layer),vertices=[NS(co=V(*p)) for p in points],loops=[NS(vertex_index=i) for i,p in enumerate(points)],polygons=[NS(normal=V(0,0,1),loop_indices=range(len(points)))])
 scope['uv_box'](NS(name=name,data=mesh),size,'wood',index,offset,stamp)
 return [entry.uv for entry in layer.data]
left=mapped('lid-panel-1',[(-.204,-.34,.75),(-.068,.34,.75)],(.136,.68,.022),offset=(-.136,0,.739),stamp=True)
right=mapped('lid-panel-2',[(-.068,.34,.75),(.068,-.34,.75)],(.136,.68,.022),offset=(0,0,.739),stamp=True)
assert left[1]==right[0], 'stamp restarts at a board boundary'
assert abs(left[0][0]-(.875-.204/2))<1e-12
assert abs(left[0][1]-(.75-.34/2))<1e-12
assert abs((right[1][0]-left[0][0])*2048-(.068+.204)*1024)<1e-9
assert .75<min(p[0] for p in left+right) and max(p[0] for p in left+right)<1
assert .5<min(p[1] for p in left+right) and max(p[1] for p in left+right)<1
points=[(-.05,-.3,0),(.05,.3,0)];size=(.1,.6,.022)
panel=mapped('front-plank-0',points,size)
frame=mapped('end-cleat',points,size)
phase=mapped('front-plank-0',points,size,256)
reverse=mapped('front-plank-0',points,size,1<<19)
assert panel[0][0]>.18 and frame[0][0]<.16, 'frame and panel crops overlap'
assert panel[0][0]==phase[0][0] and panel[0][1]!=phase[0][1], 'crop phase correlated with strip'
assert panel[0][1]<panel[1][1] and reverse[0][1]>reverse[1][1]
print(json.dumps({'continuousStamp':True,'pixelsPerMetre':1024,'separateFrameCrop':True,'independentPhase':True}))
`,
  ])
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual({
    continuousStamp: true,
    pixelsPerMetre: 1024,
    separateFrameCrop: true,
    independentPhase: true,
  })
})
