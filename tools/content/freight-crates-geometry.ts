/** Crate-only offline contact coordinates, provenance and render-mesh condensation. */
import { createHash } from 'node:crypto'
import type { Document, Node, Primitive, Property } from '@gltf-transform/core'
import { joinPrimitives } from '@gltf-transform/functions'
import {
  type FreightCell,
  type FreightPlacement,
  matchFreightPlacements,
  type Point,
  rayHit,
  requireFreightEnvelope,
  triangles,
} from './freight-crates-contract.ts'

export type FreightJoint = [axis: number, side: number, along: number, coordinate: number]
export interface FreightPiece {
  name: string
  role: string
  sourceSHA256: string
  bakedSHA256: string
  firstIndex: number
  indexCount: number
}

/** Restrained original crosscut grain; broken irregular arcs replace the old perfect ellipses. */
export function freightEndgrainSvg(kind: 'albedo' | 'normal' | 'arm'): string {
  const base = { albedo: '#5c4d3e', normal: '#8080ff', arm: '#ffc000' }[kind]
  const stroke = kind === 'albedo' ? '#3d342a' : '#ffac00'
  const arcs =
    kind === 'normal'
      ? ''
      : Array.from({ length: 52 }, (_, ring) => {
          const points = Array.from({ length: 57 }, (_point, step) => {
            const angle = (step * Math.PI) / 28
            const radius =
              28 +
              ring * 7.1 +
              Math.sin(angle * 3.1 + ring * 0.61) * 3.8 +
              Math.cos(angle * 7.3 - ring * 0.19) * 1.8
            return `${step === 0 ? 'M' : 'L'}${(-72 + Math.cos(angle) * radius).toFixed(2)},${(218 + Math.sin(angle) * radius * 0.94).toFixed(2)}`
          }).join(' ')
          return `<path d="${points}" fill="none" stroke="${stroke}" stroke-width="${ring % 4 === 0 ? 1.3 : 0.8}" opacity=".26" stroke-dasharray="${31 + (ring % 9)} ${2 + (ring % 3)}"/>`
        }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${base}"/>${arcs}</svg>`
}
export function freightResourceBaseline(doc: Document) {
  const root = doc.getRoot()
  return new Set<Property>([
    ...root.listMeshes(),
    ...root.listAccessors(),
    ...root.listMaterials(),
    ...root.listTextures(),
  ])
}

export function freightOriginalState(
  doc: Document,
  placements: FreightPlacement[],
  selected: number[],
) {
  const originalScenes = new Set(doc.getRoot().listScenes())
  const originalResources = freightResourceBaseline(doc)
  const originalNodes = new Set(doc.getRoot().listNodes())
  const originals = matchFreightPlacements(
    [...originalNodes].filter((node) => node.getName() === 'k_crate_big-placement'),
    placements,
  )
  const replaced = new Set<Node>()
  for (const index of selected) {
    const node = originals.get(index)
    if (!node) {
      throw new Error('Missing selected freight placement')
    }
    node.traverse((child) => replaced.add(child))
  }
  const unaffected = new Map(
    [...originalNodes]
      .filter((node) => !replaced.has(node))
      .map((node) => [node, treeDigest(node, false)]),
  )
  return { originalScenes, originalResources, originalNodes, originals, unaffected }
}

/** Preserve every original resource; remove only unreferenced crate-import/assembly resources. */
export function cleanupFreightResources(doc: Document, original: Set<Property>) {
  const root = doc.getRoot()
  const orphan = (property: Property) =>
    !original.has(property) && property.listParents().every((parent) => parent === root)
  for (const mesh of root.listMeshes().filter(orphan)) {
    const primitives = mesh.listPrimitives()
    mesh.dispose()
    for (const primitive of primitives) {
      if (primitive.listParents().length === 0) {
        primitive.dispose()
      }
    }
  }
  for (const property of [
    ...root.listAccessors(),
    ...root.listMaterials(),
    ...root.listTextures(),
  ]) {
    if (orphan(property)) {
      property.dispose()
    }
  }
  const newResources = [...root.listMeshes(), ...root.listAccessors()].filter(
    (property) => !original.has(property),
  )
  newResources.forEach((property, index) => {
    property.setName(`freight-resource:${index}`)
  })
  const stats = inspectFreightResources(doc)
  if (stats.orphanNewMeshes !== 0 || stats.orphanNewAccessors !== 0) {
    throw new Error('Unreferenced new freight geometry remains')
  }
  return stats
}

/** Run again on the actual written/decoded GLB, not just the pre-write graph. */
export function inspectFreightResources(doc: Document) {
  const meshes = new Set<Property>()
  const accessors = new Set<Property>()
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh()
      if (!mesh) {
        return
      }
      meshes.add(mesh)
      for (const primitive of mesh.listPrimitives()) {
        for (const accessor of [...primitive.listAttributes(), primitive.getIndices()]) {
          if (accessor) {
            accessors.add(accessor)
          }
        }
      }
    })
  }
  const freshMeshes = doc
    .getRoot()
    .listMeshes()
    .filter((mesh) => mesh.getName().startsWith('freight-resource:'))
  const freshAccessors = doc
    .getRoot()
    .listAccessors()
    .filter((accessor) => accessor.getName().startsWith('freight-resource:'))
  return {
    newMeshes: freshMeshes.length,
    newAccessors: freshAccessors.length,
    orphanNewMeshes: freshMeshes.filter((mesh) => !meshes.has(mesh)).length,
    orphanNewAccessors: freshAccessors.filter((accessor) => !accessors.has(accessor)).length,
    totalDecodedMeshes: doc.getRoot().listMeshes().length,
    totalDecodedAccessors: doc.getRoot().listAccessors().length,
  }
}

/** Compare the actual indexed stream after joining, independent of vertex renumbering. */
export function indexedFreightDigest(
  primitive: Primitive,
  first = 0,
  count = primitive.getIndices()?.getCount() ?? 0,
) {
  const indices = primitive.getIndices()
  if (!indices || count === 0) {
    throw new Error('Missing freight indexed stream')
  }
  const hash = createHash('sha256')
  for (const semantic of primitive.listSemantics().sort((a, b) => a.localeCompare(b, 'en'))) {
    const attribute = primitive.getAttribute(semantic)
    const array = attribute?.getArray()
    if (!(attribute && array)) {
      throw new Error('Missing freight attribute stream')
    }
    hash.update(
      JSON.stringify([
        semantic,
        attribute.getType(),
        attribute.getComponentType(),
        attribute.getNormalized(),
      ]),
    )
    const bytes = attribute.getElementSize() * array.BYTES_PER_ELEMENT
    for (let index = first; index < first + count; index++) {
      hash.update(
        new Uint8Array(array.buffer, array.byteOffset + indices.getScalar(index) * bytes, bytes),
      )
    }
  }
  return hash.digest('hex')
}

export function joinFreight(primitives: Primitive[]) {
  const result = joinPrimitives(primitives)
  let offset = 0
  for (const primitive of primitives) {
    const count = primitive.getIndices()?.getCount() ?? 0
    if (
      result.getMaterial() !== primitive.getMaterial() ||
      indexedFreightDigest(result, offset, count) !== indexedFreightDigest(primitive)
    ) {
      throw new Error('Freight merge changed a material or indexed attribute stream')
    }
    offset += count
  }
  return result
}

/** Only contacts within one micrometre of an authored cell plane may be corrected. */
export function freightContactCoordinate(value: number, planes: number[]) {
  const plane = planes.find((coordinate) => Math.abs(value - coordinate) <= 0.000_001)
  const result = Math.fround(plane ?? value)
  if (plane !== undefined && Math.abs(result - value) > 0.000_001) {
    throw new Error('Freight seam correction exceeds one micrometre')
  }
  return result
}

function cellOrigin(cell: FreightCell, axis: number) {
  return axis === 1 ? (cell.min[axis] ?? 0) : ((cell.min[axis] ?? 0) + (cell.max[axis] ?? 0)) / 2
}
function boundaryJoints(
  placement: FreightPlacement,
  cell: FreightCell,
  face: { axis: number; side: number },
) {
  return [0, 1, 2]
    .filter((along) => along !== face.axis)
    .flatMap((along) =>
      [cell.min[along] ?? 0, cell.max[along] ?? 0]
        .filter(
          (endpoint) =>
            endpoint > (placement.min[along] ?? 0) && endpoint < (placement.max[along] ?? 0),
        )
        .map(
          (endpoint): FreightJoint => [
            face.axis,
            face.side,
            along,
            endpoint - cellOrigin(cell, along),
          ],
        ),
    )
}
function jointRays(cell: FreightCell, plane: number, joint: FreightJoint) {
  const [axis, side, along, coordinate] = joint
  const other = [0, 1, 2].find((value) => value !== axis && value !== along)
  if (other === undefined || along === axis) {
    throw new Error('Invalid freight joint axes')
  }
  return [0.25, 0.5, 0.75].flatMap((fraction) =>
    [-0.0001, -0.000_001, 0, 0.000_001, 0.0001].map((offset) => {
      const origin: Point = [0, 0, 0]
      origin[axis] = plane + side * 0.1
      origin[along] = coordinate + offset + cellOrigin(cell, along)
      origin[other] =
        (cell.min[other] ?? 0) + fraction * ((cell.max[other] ?? 0) - (cell.min[other] ?? 0))
      const direction: Point = [0, 0, 0]
      direction[axis] = -side
      return { origin, direction, expectedDistance: 0.1, face: `${axis}:${side}:joint` }
    }),
  )
}
/** Joint rays are additional to the unchanged regular contact grid. */
export function freightJointSamples(
  placement: FreightPlacement,
  cells: { cell: string; joints: FreightJoint[] }[],
) {
  return placement.cells.flatMap((cell) => {
    const authored = cells.find((entry) => entry.cell === cell.id)
    if (!authored) {
      throw new Error('Missing freight joint provenance')
    }
    return [0, 1, 2].flatMap((axis) =>
      [-1, 1].flatMap((side) => {
        const plane = (side < 0 ? cell.min[axis] : cell.max[axis]) ?? 0
        if (
          Math.abs(plane - ((side < 0 ? placement.min[axis] : placement.max[axis]) ?? 0)) > 1e-8
        ) {
          return []
        }
        return [
          ...authored.joints.filter((joint) => joint[0] === axis && joint[1] === side),
          ...boundaryJoints(placement, cell, { axis, side }),
        ].flatMap((joint) => jointRays(cell, plane, joint))
      }),
    )
  })
}

export function checkFreightPlacement(
  placement: FreightPlacement,
  branch: Node,
  tier: string,
  cells: { cell: string; joints: FreightJoint[] }[],
) {
  const faces = triangles(branch, false)
  const min: Point = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max: Point = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const face of faces) {
    for (const point of face) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis] ?? Number.POSITIVE_INFINITY, point[axis] ?? 0)
        max[axis] = Math.max(max[axis] ?? Number.NEGATIVE_INFINITY, point[axis] ?? 0)
      }
    }
  }
  const contact = requireFreightEnvelope(placement, { min, max }, (origin, direction) =>
    rayHit(faces, origin, direction),
  )
  const samples = freightJointSamples(placement, cells)
  const joints = requireFreightEnvelope(
    placement,
    { min, max },
    (origin, direction) => rayHit(faces, origin, direction),
    samples,
  )
  return {
    coverIndex: placement.coverIndex,
    tier,
    min,
    max,
    triangles: triangles(branch, true).length,
    ...contact,
    jointContact: { ...joints, samples: samples.length },
    cells,
  }
}

export function treeDigest(root: Node, recursive = true): string {
  const hash = createHash('sha256')
  const visit = (node: Node) => {
    hash.update(
      JSON.stringify([
        node.getName(),
        node.getTranslation(),
        node.getRotation(),
        node.getScale(),
        node.getExtras(),
      ]),
    )
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      hash.update(JSON.stringify(primitive.getMaterial()?.getName() ?? null))
      for (const name of [...primitive.listSemantics()].sort((a, b) => a.localeCompare(b, 'en'))) {
        const accessor = primitive.getAttribute(name)
        const bytes = accessor?.getArray()
        if (bytes) {
          hash.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        }
      }
      const indices = primitive.getIndices()?.getArray()
      if (indices) {
        hash.update(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength))
      }
    }
    if (recursive) {
      for (const child of node.listChildren()) {
        visit(child)
      }
    }
  }
  visit(root)
  return hash.digest('hex')
}
export function cloneTree(doc: Document, source: Node): Node {
  const copy = doc
    .createNode(source.getName())
    .setTranslation(source.getTranslation())
    .setRotation(source.getRotation())
    .setScale(source.getScale())
    .setMesh(source.getMesh())
    .setExtras(source.getExtras())
  for (const child of source.listChildren()) {
    copy.addChild(cloneTree(doc, child))
  }
  return copy
}
export function removeTree(node: Node): void {
  for (const child of node.listChildren()) {
    removeTree(child)
  }
  node.dispose()
}

/** Independent CPU reference for the native world-position UV1 shader, at actual authored poses. */
export function freightWorldUv(positions: number[], matrix: number[]) {
  const values = new Float32Array((positions.length / 3) * 2)
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3] ?? 0
    const y = positions[i * 3 + 1] ?? 0
    const z = positions[i * 3 + 2] ?? 0
    values[i * 2] =
      ((matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0)) /
      1024
    values[i * 2 + 1] =
      ((matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0)) /
      1024
  }
  return values
}
