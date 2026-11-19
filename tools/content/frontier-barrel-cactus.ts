/** Replace the reviewed fence-facing short barrels within the existing vegetation draw slots. */
import assert from 'node:assert/strict'
import type { Document, Material, Primitive } from '@gltf-transform/core'
import { prune } from '@gltf-transform/functions'
import { fitBarrel } from './frontier-barrel-shape.ts'
import { islandRoots } from './frontier-vegetation.ts'

type Point = [number, number, number]
const BARRELS = new Map([
  ['flora-427', 11],
  ['flora-428', 12],
  ['flora-433', 9],
  ['flora-434', 5],
])

/** Authored local centers of the other nine shrubs visible from the town fence. */
const VISIBLE_BARRELS = new Map<string, readonly (readonly [number, number])[]>([
  [
    'flora-416',
    [
      [108.919_387_817_382_81, -0.866_620_518_267_154_7],
      [108.863_544_464_111_33, -1.168_290_495_872_497_6],
    ],
  ],
  [
    'flora-425',
    [
      [57.962_043_762_207_03, -0.726_881_526_410_579_7],
      [55.372_180_938_720_7, -0.327_566_228_806_972_5],
      [55.436_109_542_846_68, -0.535_169_009_119_272_2],
    ],
  ],
  [
    'flora-430',
    [
      [-1.045_683_320_611_715_3, 100.298_316_955_566_4],
      [-0.567_290_827_631_950_4, 99.916_015_625],
      [-1.126_150_012_016_296_4, 99.410_095_214_843_75],
    ],
  ],
  ['flora-432', [[49.228_693_008_422_85, 0.250_661_537_051_200_87]]],
])

function islands(primitive: Primitive) {
  const groups = new Map<number, number[]>()
  for (const [vertex, root] of islandRoots(primitive).entries()) {
    const group = groups.get(root)
    if (group) {
      group.push(vertex)
    } else {
      groups.set(root, [vertex])
    }
  }
  return [...groups.values()]
}

function readers(primitive: Primitive) {
  const positions = primitive.getAttribute('POSITION')
  const colors = primitive.getAttribute('COLOR_0')
  assert(positions && colors, 'Missing vegetation geometry or colors')
  const normalized = colors.getNormalized() || colors.getComponentType() === 5126
  return {
    point: (i: number) => positions.getElement(i, [0, 0, 0] as Point),
    color: (i: number) => {
      const rgb = colors.getElement(i, [0, 0, 0] as Point)
      return rgb.map((channel) => Math.round(normalized ? channel * 255 : channel)) as Point
    },
  }
}

function removeNeedles(primitive: Primitive, stemAnchors: Map<string, number>, stems: number) {
  const { point, color } = readers(primitive)
  const removed = new Set<number>()
  const anchors = new Map<string, number>()
  const counts = new Uint32Array(stems)
  for (const [first, second, tip, extra] of islands(primitive)) {
    if (
      first === undefined ||
      second === undefined ||
      tip === undefined ||
      extra !== undefined ||
      color(first).join() !== color(second).join() ||
      color(tip).join() !== '53,65,12'
    ) {
      continue
    }
    const a = point(first)
    const b = point(second)
    const matches = [a.join(), b.join()].filter((key) => stemAnchors.has(key))
    const [anchor] = matches
    if (anchor === undefined) {
      continue
    }
    const span = Math.hypot(a[0] - b[0], a[2] - b[2])
    if (matches.length !== 1 || a[1] !== b[1] || span <= 0.02 || span >= 0.1) {
      throw new Error('Ambiguous barrel needle attachment')
    }
    const index = stemAnchors.get(anchor)
    assert(index !== undefined, 'Missing barrel index')
    counts[index] = (counts[index] ?? 0) + 1
    anchors.set(anchor, (anchors.get(anchor) ?? 0) + 1)
    removed.add(first).add(second).add(tip)
  }
  if (counts.some((n) => n < 2 || n > 18 || n % 2) || [...anchors.values()].some((n) => n !== 2)) {
    throw new Error('Legacy barrel needle pairs changed')
  }
  retireLegacyFaces(primitive, removed, 'needle')
  return removed.size / 3
}

/** Keep the original indexed triangle order and vertex streams for neighboring islands. */
function retireLegacyFaces(primitive: Primitive, removed: ReadonlySet<number>, label: string) {
  const indices = primitive.getIndices()
  assert(indices, `Missing legacy ${label} indices`)
  const kept: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const face = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)]
    const count = face.filter((v) => removed.has(v)).length
    if (count === 0) {
      kept.push(...face)
    } else if (count !== 3) {
      throw new Error(`Barrel ${label} shares an unselected triangle`)
    }
  }
  if (kept.length === 0) {
    throw new Error(`Removing barrel ${label} emptied a foliage draw`)
  }
  primitive.setIndices(indices.clone().setArray(new Uint16Array(kept)))
}

function replaceStems(
  stem: Primitive,
  destination: Primitive,
  plants: readonly number[][],
  material: Material,
) {
  if (plants.some((plant) => plant.length !== 18)) {
    throw new Error('Legacy barrel placement changed')
  }
  const { point, color } = readers(stem)
  const anchors = new Map<string, number>()
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (const [plantIndex, plant] of plants.entries()) {
    const reference = plant.map(point)
    const darkest = Math.min(...plant.map((vertex) => color(vertex)[1]))
    const base = plant.filter((vertex) => color(vertex)[1] <= darkest + 1).map(point)
    if (
      base.length < 4 ||
      Math.min(...base.map((p) => p[1])) !== Math.min(...reference.map((p) => p[1]))
    ) {
      throw new Error(`Missing reference ground ring in ${stem.getMaterial()?.getName()}`)
    }
    for (const p of reference) {
      const key = p.join()
      if (anchors.has(key)) {
        throw new Error(`Shared barrel needle anchor in ${stem.getMaterial()?.getName()}`)
      }
      anchors.set(key, plantIndex)
    }
    const offset = positions.length / 3
    const shape = fitBarrel(
      reference,
      base,
      (0.13 + (stem === destination ? plantIndex : (plant[0] ?? 0)) * 0.379) % 1.4,
    )
    for (const face of shape.faces) {
      indices.push(...face.map((vertex) => vertex + offset))
    }
    positions.push(...shape.positions.flat())
    normals.push(...shape.normals.flat())
    colors.push(...shape.colors.flatMap((p) => p.map((channel) => Math.round(channel * 255))))
  }
  for (const [name, array] of [
    ['POSITION', new Float32Array(positions)],
    ['NORMAL', new Float32Array(normals)],
    ['TEXCOORD_0', new Float32Array((positions.length / 3) * 2)],
    ['COLOR_0', new Uint8Array(colors)],
  ] as const) {
    const original = stem.getAttribute(name)
    assert(original, `Missing barrel attribute ${name} in ${stem.getMaterial()?.getName()}`)
    destination.setAttribute(
      name,
      original
        .clone()
        .setNormalized(name === 'COLOR_0')
        .setArray(array),
    )
  }
  const oldIndices = stem.getIndices()
  assert(oldIndices, `Missing stem indices in ${stem.getMaterial()?.getName()}`)
  destination
    .setIndices(oldIndices.clone().setArray(new Uint16Array(indices)))
    .setMaterial(material)
  for (const target of destination.listTargets()) {
    const wind = target.getAttribute('POSITION')
    assert(wind, `Missing stem wind morph in ${stem.getMaterial()?.getName()}`)
    target.setAttribute('POSITION', wind.clone().setArray(new Float32Array(positions.length)))
  }
  return anchors
}

function readFloraParts(document: Document, owner: string) {
  const mesh = document
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === owner)
    ?.getMesh()
  const primitives = mesh?.listPrimitives()
  const stem = primitives?.find((part) => part.getMaterial()?.getName() === 'Desert cactus skin')
  const shrubs = primitives?.find((part) => part.getMaterial()?.getName() === 'Desert shrub leaves')
  assert(mesh && stem && shrubs, `Missing original barrel or shrub geometry in ${owner}`)
  return { mesh, stem, shrubs }
}

/** Select by original local center, not vertex order or proximity to another plant. */
function selectVisibleBarrels(stem: Primitive, centers: readonly (readonly [number, number])[]) {
  const { point } = readers(stem)
  const original = islands(stem)
  const sameCenter = (plant: number[], axis: 0 | 2, center: number) => {
    const coordinate = plant.map((vertex) => point(vertex)[axis])
    return (Math.min(...coordinate) + Math.max(...coordinate)) / 2 === center
  }
  return centers.map(([x, z]) => {
    const eligible = original.filter(
      (candidate) => sameCenter(candidate, 0, x) && sameCenter(candidate, 2, z),
    )
    const [plant] = eligible
    assert(
      plant && eligible.length === 1 && plant.length === 18,
      `Unexpected barrel center ${x}, ${z}`,
    )
    return plant
  })
}

export async function authorBarrelCacti(document: Document) {
  const material = document
    .createMaterial('Desert barrel cactus • weathered stem and areoles')
    .setBaseColorFactor([0.76, 0.77, 0.61, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.86)
  const results: { owner: string; plants: number; retiredNeedles: number }[] = []
  for (const [owner, count] of BARRELS) {
    const { stem, shrubs } = readFloraParts(document, owner)
    const plants = islands(stem)
    assert(plants.length === count, `Unexpected number of barrels in ${owner}`)
    const anchors = replaceStems(stem, stem, plants, material)
    const retiredNeedles = removeNeedles(shrubs, anchors, count)
    results.push({ owner, plants: count, retiredNeedles })
  }
  for (const [owner, centers] of VISIBLE_BARRELS) {
    const { mesh, stem, shrubs } = readFloraParts(document, owner)
    const plants = selectVisibleBarrels(stem, centers)
    const replacement = stem.clone()
    for (const target of replacement.listTargets()) {
      replacement.removeTarget(target).addTarget(target.clone())
    }
    const anchors = replaceStems(stem, replacement, plants, material)
    retireLegacyFaces(stem, new Set(plants.flat()), 'stem')
    const retiredNeedles = removeNeedles(shrubs, anchors, plants.length)
    mesh.addPrimitive(replacement)
    results.push({ owner, plants: plants.length, retiredNeedles })
  }
  console.log('Frontier barrel cacti', results)
  await document.transform(
    prune({ propertyTypes: ['Accessor'], keepAttributes: true, keepIndices: true }),
  )
}
