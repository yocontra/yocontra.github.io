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
  const indices = primitive.getIndices()
  assert(indices, 'Missing legacy needle indices')
  const kept: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const face = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)]
    const count = face.filter((v) => removed.has(v)).length
    if (count === 0) {
      kept.push(...face)
    } else if (count !== 3) {
      throw new Error('Barrel needle shares vertices with a neighboring shrub')
    }
  }
  if (kept.length === 0) {
    throw new Error('Removing barrel needles unexpectedly emptied a foliage draw')
  }
  primitive.setIndices(indices.clone().setArray(new Uint16Array(kept)))
  return removed.size / 3
}

function replaceStems(stem: Primitive, material: Material, owner: string, count: number) {
  const plants = islands(stem)
  if (plants.length !== count || plants.some((plant) => plant.length !== 18)) {
    throw new Error(`Legacy barrel placement changed in ${owner}`)
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
      throw new Error(`Missing reference ground ring in ${owner}`)
    }
    for (const p of reference) {
      const key = p.join()
      if (anchors.has(key)) {
        throw new Error(`Shared barrel needle anchor in ${owner}`)
      }
      anchors.set(key, plantIndex)
    }
    const offset = positions.length / 3
    const shape = fitBarrel(reference, base, (0.13 + plantIndex * 0.379) % 1.4)
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
    assert(original, `Missing barrel attribute ${name} in ${owner}`)
    stem.setAttribute(
      name,
      original
        .clone()
        .setNormalized(name === 'COLOR_0')
        .setArray(array),
    )
  }
  const oldIndices = stem.getIndices()
  assert(oldIndices, `Missing stem indices in ${owner}`)
  stem.setIndices(oldIndices.clone().setArray(new Uint16Array(indices))).setMaterial(material)
  for (const target of stem.listTargets()) {
    const wind = target.getAttribute('POSITION')
    assert(wind, `Missing stem wind morph in ${owner}`)
    target.setAttribute('POSITION', wind.clone().setArray(new Float32Array(positions.length)))
  }
  return anchors
}

export async function authorBarrelCacti(document: Document) {
  const material = document
    .createMaterial('Desert barrel cactus • weathered stem and areoles')
    .setBaseColorFactor([0.76, 0.77, 0.61, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.86)
  const results: { owner: string; plants: number; retiredNeedles: number }[] = []
  for (const [owner, count] of BARRELS) {
    const mesh = document
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === owner)
      ?.getMesh()
    const primitives = mesh?.listPrimitives()
    const stem = primitives?.find((part) => part.getMaterial()?.getName() === 'Desert cactus skin')
    const shrubs = primitives?.find(
      (part) => part.getMaterial()?.getName() === 'Desert shrub leaves',
    )
    if (!(stem && shrubs)) {
      throw new Error(`Missing original barrel or shrub geometry in ${owner}`)
    }
    const anchors = replaceStems(stem, material, owner, count)
    const retiredNeedles = removeNeedles(shrubs, anchors, count)
    results.push({ owner, plants: count, retiredNeedles })
  }
  console.log('Frontier barrel cacti', results)
  await document.transform(
    prune({ propertyTypes: ['Accessor'], keepAttributes: true, keepIndices: true }),
  )
}
