/** Replace only the cast shell, with its existing yoke, clapper and animation all retained. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Primitive } from '@gltf-transform/core'
import { compactPrimitive, copyToDocument, prune, unpartition } from '@gltf-transform/functions'
import { externalize, surfaceMaterial } from './animal-prop-surfaces.ts'
import { frontierIO } from './frontier-geometry.ts'
import { normalizeSkinnedAsset } from './normalize-skinned-nodes.ts'

const output = process.argv[2]
if (!output) {
  throw new Error('Supply an output directory for the fitted clockwork')
}
const [clock, art] = await Promise.all([
  frontierIO.read('tools/art/environments/clockwork-base.glb'),
  frontierIO.read(process.argv[3] ?? 'tools/art/environments/clock-bell.glb'),
])
const bell = clock
  .getRoot()
  .listNodes()
  .find((node) => node.getName() === 'clock-bell')
const mount = bell
  ?.getSkin()
  ?.listJoints()
  .findIndex((joint) => joint.getName() === 'clock-3-8')
const mesh = bell?.getMesh()
const old = mesh?.listPrimitives()[0]
const original = old?.getIndices()
const faces = original?.getArray()
const points = old?.getAttribute('POSITION')
const sculpt = art.getRoot().listMeshes()[0]?.listPrimitives()[0]
if (!(mesh && old && original && points && sculpt && faces?.length === 2472) || mount !== 8) {
  throw new Error('The canonical clockwork bell has changed')
}
// Positions weld across the old UV seam. The casting's lower rim seeds its connected surface.
const keys = Array.from({ length: points.getCount() }, (_, index) =>
  points
    .getElement(index, [] as number[])
    .map((value) => value.toFixed(5))
    .join(','),
)
const shellVertices = new Set<string>()
for (let i = 0; i < keys.length; i++) {
  const [x = 0, y = 0, z = 0] = points.getElement(i, [])
  const key = keys[i]
  if (key && y < 15.84 && Math.hypot(x, z - 63.5) > 0.62) {
    shellVertices.add(key)
  }
}
const shellFaces = new Set<number>()
let previous = -1
while (previous !== shellFaces.size) {
  previous = shellFaces.size
  for (let i = 0; i < faces.length; i += 3) {
    const vertices = Array.from(faces.subarray(i, i + 3), (index) => keys[index] ?? '')
    if (!shellFaces.has(i / 3) && vertices.some((vertex) => shellVertices.has(vertex))) {
      shellFaces.add(i / 3)
      for (const vertex of vertices) {
        shellVertices.add(vertex)
      }
    }
  }
}
if (shellFaces.size !== 624) {
  throw new Error('The old shell no longer has independent topology')
}
original.setArray(faces.filter((_, index) => !shellFaces.has(Math.floor(index / 3))))
compactPrimitive(old)
const replacement = copyToDocument(clock, art, [sculpt]).get(sculpt) as Primitive
const position = replacement.getAttribute('POSITION')
const buffer = position?.getBuffer()
if (!(buffer && position)) {
  throw new Error('The replacement bell is missing its vertices')
}
const joints = new Uint8Array(position.getCount() * 4)
const weights = new Float32Array(joints.length)
const colors = new Float32Array(position.getCount() * 3)
for (let i = 0; i < position.getCount(); i++) {
  joints[i * 4] = mount
  weights[i * 4] = 1
  const [x = 0, y = 0, z = 0] = position.getElement(i, [])
  const patina = 0.88 + 0.12 * Math.sin(x * 52 + z * 31) * Math.sin(y * 61 - z * 42)
  colors.set([patina, patina * 0.84, patina * 0.67], i * 3)
}
const bronze = (await surfaceMaterial(clock, 'iron'))
  .clone()
  .setName('Railway cast bronze')
  .setBaseColorFactor([0.65, 0.46, 0.27, 1])
  .setMetallicFactor(0.72)
  .setRoughnessFactor(0.71)
replacement
  .setMaterial(bronze)
  .setAttribute(
    'JOINTS_0',
    clock.createAccessor().setBuffer(buffer).setType('VEC4').setArray(joints),
  )
  .setAttribute(
    'WEIGHTS_0',
    clock.createAccessor().setBuffer(buffer).setType('VEC4').setArray(weights),
  )
  .setAttribute(
    'COLOR_0',
    clock.createAccessor().setBuffer(buffer).setType('VEC3').setArray(colors),
  )
mesh.addPrimitive(replacement)
await clock.transform(prune({ keepAttributes: true, keepLeaves: true }), unpartition())
await mkdir(join(output, 'ambient'), { recursive: true })
await frontierIO.write(join(output, 'clockwork.glb'), clock)
await externalize(clock)
const native = join(output, 'ambient', 'clockwork.glb')
await frontierIO.write(native, clock)
await normalizeSkinnedAsset(native)
