/** Fit the forged meshes to the retained boot mounts and reuse the catalogue's native steel maps. */
import { NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  copyToDocument,
  dedup,
  joinPrimitives,
  prune,
  unpartition,
  weld,
} from '@gltf-transform/functions'

const footMount = /^mount\.Foot[LR]\.accessory$/u
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

export async function fitForgedSpurs(source: string, rig: string, target: string): Promise<void> {
  const [art, original, body] = await Promise.all([io.read(source), io.read(rig), io.read(target)])
  const position = original.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute('POSITION')
  if (!position) {
    throw new Error('Missing base spur fit')
  }
  const low = position.getMin([])
  const high = position.getMax([])
  const center = low.map((a, i) => (a + (high[i] ?? 0)) / 2)
  const half = Math.max(...low.map((a, i) => ((high[i] ?? a) - a) / 2))
  const mounts = body
    .getRoot()
    .listNodes()
    .filter((node) => footMount.test(node.getName()))
  const nodes = mounts.flatMap((mount) => mount.listChildren())
  const meshes = nodes.map((node) => node.getMesh())
  const metal = meshes[0]?.listPrimitives()[0]?.getMaterial()
  if (!metal || mounts.length !== 2 || nodes.length !== 2 || meshes.some((m) => !m)) {
    throw new Error('Missing two fitted boot locations')
  }
  const parts = art
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
  const copied = copyToDocument(body, art, parts)
  const fitted = parts.map((p) => {
    const part = copied.get(p) as Primitive
    const shape = part.getAttribute('POSITION')
    const buffer = shape?.getBuffer()
    const material = part.getMaterial()
    if (!(shape && buffer && material)) {
      throw new Error('Missing forged spur part')
    }
    const rgba = material.getBaseColorFactor()
    const rgb = new Float32Array(shape.getCount() * 3)
    for (let i = 0; i < shape.getCount(); i++) {
      const xyz = shape.getElement(i, [])
      shape.setElement(
        i,
        xyz.map((coordinate, k) => (coordinate - (center[k] ?? 0)) / half),
      )
      rgb.set(rgba.slice(0, 3), i * 3)
    }
    part.setAttribute(
      'COLOR_0',
      body.createAccessor().setBuffer(buffer).setType('VEC3').setArray(rgb),
    )
    return part.setMaterial(metal)
  })
  const piece = body.createMesh('Forged western spur').addPrimitive(joinPrimitives(fitted))
  for (const part of fitted) {
    part.dispose()
  }
  for (const node of nodes) {
    node.setMesh(piece)
  }
  for (const mesh of new Set(meshes)) {
    mesh?.dispose()
  }
  await body.transform(
    dedup(),
    weld(),
    prune({ keepAttributes: true, keepLeaves: true }),
    unpartition(),
  )
  await io.write(target, body)
}
