/** Fit the new straw meshes within the exact extents of the existing rolling props. */
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Primitive } from '@gltf-transform/core'
import { copyToDocument, dedup, prune, unpartition } from '@gltf-transform/functions'
import { calculateTangents } from 'playcanvas'
import { externalize, surfaceMaterial } from './animal-prop-surfaces.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'
import { frontierIO } from './frontier-geometry.ts'
import { optimizeAsset } from './optimize.ts'

const variants = {
  'frontier-tumbleweeds': 'Perdition dry tumbleweed',
  'duel-tumbleweeds': 'Duel dry tumbleweed',
  tumbleweed: 'Duel dry tumbleweed',
} as const
const source = 'tools/art/environments'
const output = process.argv[2]
const library = process.argv[3] ?? join(source, 'tumbleweed-skeletons.glb')
if (!output) {
  throw new Error('Supply an output directory for the authored tumbleweeds')
}
const art = await frontierIO.read(library)
await Promise.all(
  ['ambient', 'dynamic'].map((folder) => mkdir(join(output, folder), { recursive: true })),
)
for (const [name, sculpt] of Object.entries(variants)) {
  const category = name === 'tumbleweed' ? 'dynamic' : 'ambient'
  const working = category === 'dynamic' ? 'tools/art/props' : source
  const doc = await frontierIO.read(join(working, `${name}.glb`))
  const mesh = doc.getRoot().listMeshes()[0]
  const original = mesh?.listPrimitives()[0]
  const bounds = original?.getAttribute('POSITION')
  const shape = art
    .getRoot()
    .listMeshes()
    .find((m) => m.getName() === sculpt)
    ?.listPrimitives()[0]
  if (!(mesh && original && bounds && shape) || doc.getRoot().listMeshes().length !== 1) {
    throw new Error(`Missing the shared roll geometry for ${name}`)
  }
  const newArt = copyToDocument(doc, art, [shape]).get(shape) as Primitive
  const position = newArt.getAttribute('POSITION')
  const normal = newArt.getAttribute('NORMAL')
  const uv = newArt.getAttribute('TEXCOORD_0')
  const index = newArt.getIndices()
  const buffer = position?.getBuffer()
  const indices = index?.getArray()
  if (!(position && normal && uv && buffer && indices)) {
    throw new Error(`The authored tumbleweed ${sculpt} is incomplete`)
  }
  const lo = bounds.getMin([])
  const hi = bounds.getMax([])
  const sculptLo = position.getMin([])
  const sculptHi = position.getMax([])
  const axes = [0, 1, 2] as const
  const extents = axes.map((axis) => {
    const start = sculptLo[axis] ?? 0
    const end = sculptHi[axis] ?? 0
    if (end - start < 0.1) {
      throw new Error(`Missing branch axis for ${sculpt}`)
    }
    return ((hi[axis] ?? 0) - (lo[axis] ?? 0)) / (end - start)
  })
  for (let vertex = 0; vertex < position.getCount(); vertex++) {
    const point = position.getElement(vertex, [])
    const direction = normal.getElement(vertex, [])
    position.setElement(
      vertex,
      axes.map((i) => ((point[i] ?? 0) - (sculptLo[i] ?? 0)) * (extents[i] ?? 1) + (lo[i] ?? 0)),
    )
    const adjusted = axes.map((i) => (direction[i] ?? 0) / (extents[i] ?? 1))
    const length = Math.hypot(...adjusted) || 1
    normal.setElement(
      vertex,
      adjusted.map((value) => value / length),
    )
  }
  const positions = position.getArray()
  const normals = normal.getArray()
  const uvs = uv.getArray()
  if (!(positions && normals && uvs)) {
    throw new Error(`Missing fitted tumbleweed attributes for ${name}`)
  }
  const tangents = calculateTangents(positions, normals, uvs, indices)
  newArt
    .setAttribute(
      'TANGENT',
      doc.createAccessor().setType('VEC4').setArray(new Float32Array(tangents)).setBuffer(buffer),
    )
    .setMaterial(
      (await surfaceMaterial(doc, 'straw', 'Dry tumbleweed branches')).setBaseColorFactor([
        0.66, 0.49, 0.34, 1,
      ]),
    )
  mesh.addPrimitive(newArt)
  mesh.removePrimitive(original)
  original.dispose()
  await doc.transform(dedup(), prune({ keepAttributes: true, keepLeaves: true }), unpartition())
  const edited = join(output, `${name}.glb`)
  await frontierIO.write(edited, doc)
  const published = join(output, category, `${name}.glb`)
  if (name === 'frontier-tumbleweeds') {
    await copyFile(edited, published)
    await optimizeAsset(published)
    await compressEnvironmentTextures(published)
  } else {
    await externalize(doc)
    await frontierIO.write(published, doc)
  }
  console.log(name, indices.length / 3, 'branch triangles')
}
