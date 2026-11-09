/** Move two complete authored street benches clear of the window sills. */
import { createHash } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Mat4, Vec3 } from 'playcanvas'

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}
const source = argument('--source', 'tools/art/environments/duel.glb')
const output = argument('--output', source)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const bytes = new Uint8Array(await Bun.file(source).arrayBuffer())
const document = await io.readBinary(bytes)
const recipe = 'street-bench-clearance-v1'
if (document.getRoot().getExtras().campaignSeatClearance) {
  if (document.getRoot().getExtras().campaignSeatClearance !== recipe) {
    throw new Error('Unknown campaign bench authoring recipe')
  }
  if (source !== output) {
    await copyFile(source, output)
  }
  console.log('Campaign bench clearance is already authored')
} else {
  const node = document
    .getRoot()
    .listNodes()
    .find((entry) => entry.getName() === 'kit-5')
  const mesh = node?.getMesh()
  const primitive = mesh?.listPrimitives()[0]
  const original = primitive?.getAttribute('POSITION')
  const indices = primitive?.getIndices()
  if (!(node && mesh && primitive && original && indices) || original.getNormalized()) {
    throw new Error('Expected the preserved float-position street Kit primitive')
  }
  if (
    document
      .getRoot()
      .listNodes()
      .filter((entry) => entry.getMesh() === mesh).length !== 1
  ) {
    throw new Error('Street bench geometry unexpectedly has shared mesh instances')
  }
  // Recover complete disconnected authored parts, joining only actual welded seams.
  const parents = Array.from({ length: original.getCount() }, (_, i) => i)
  const find = (i: number): number => {
    const parent = parents[i]
    if (parent === undefined) {
      throw new Error('Invalid source geometry index')
    }
    if (parent === i) {
      return i
    }
    const root = find(parent)
    parents[i] = root
    return root
  }
  const join = (a: number, b: number) => {
    parents[find(a)] = find(b)
  }
  const seams = new Map<string, number>()
  for (let i = 0; i < original.getCount(); i++) {
    const key = original
      .getElement(i, [])
      .map((v) => Math.round(v * 100_000))
      .join(',')
    const previous = seams.get(key)
    if (previous === undefined) {
      seams.set(key, i)
    } else {
      join(i, previous)
    }
  }
  for (let i = 0; i < indices.getCount(); i += 3) {
    join(indices.getScalar(i), indices.getScalar(i + 1))
    join(indices.getScalar(i), indices.getScalar(i + 2))
  }
  const parts = new Map<number, Set<number>>()
  for (let i = 0; i < indices.getCount(); i++) {
    const vertex = indices.getScalar(i)
    const group = find(vertex)
    const part = parts.get(group) ?? new Set<number>()
    part.add(vertex)
    parts.set(group, part)
  }
  const matrix = new Mat4().set(node.getWorldMatrix())
  const inverse = matrix.clone().invert()
  const originalArray = original.getArray()
  if (!originalArray) {
    throw new Error('Street Kit position data is unavailable')
  }
  const position = original.clone().setArray(originalArray.slice())
  primitive.setAttribute('POSITION', position)
  const receipt: { name: string; worldTranslation: number[]; parts: number; vertices: number[] }[] =
    []
  for (const { name, x, z, dx } of [
    { name: 'worker', x: 10.795, z: 11.3, dx: -0.02 },
    { name: 'woman', x: -10.795, z: 14.3, dx: 0.06 },
  ]) {
    const vertices = new Set<number>()
    let count = 0
    for (const part of parts.values()) {
      const points = [...part].map((i) => {
        const [px = 0, py = 0, pz = 0] = original.getElement(i, [])
        return matrix.transformPoint(new Vec3(px, py, pz))
      })
      if (
        !points.every(
          (p) => Math.abs(p.x - x) < 0.28 && Math.abs(p.z - z) < 1.4 && p.y > 0.32 && p.y < 0.87,
        )
      ) {
        continue
      }
      count++
      for (const i of part) {
        vertices.add(i)
      }
    }
    // Nine complete bench parts: two legs, two feet, wood top and four fasteners.
    if (count !== 9 || vertices.size !== 422) {
      throw new Error(`Unexpected ${name} bench topology: ${count}/${vertices.size}`)
    }
    const delta = inverse.transformVector(new Vec3(dx, 0, 0))
    for (const i of vertices) {
      const [px = 0, py = 0, pz = 0] = original.getElement(i, [])
      position.setElement(i, [px + delta.x, py + delta.y, pz + delta.z])
    }
    receipt.push({
      name,
      worldTranslation: [dx, 0, 0],
      parts: count,
      vertices: [...vertices].sort((a, b) => a - b),
    })
  }
  if (original.listParents().every((parent) => parent.propertyType === 'Root')) {
    original.dispose()
  }
  document.getRoot().setExtras({
    ...document.getRoot().getExtras(),
    campaignSeatClearance: recipe,
    campaignSeatClearanceSourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    campaignSeatClearanceReceipt: receipt,
  })
  await io.write(output, document)
  console.log(
    'Authored two complete benches; all other positions, UVs, materials and heights retained',
    receipt.map(({ vertices, ...entry }) => ({ ...entry, vertices: vertices.length })),
  )
}
