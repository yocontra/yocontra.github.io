/** Replace the visible steel ahead of the preserved hand and holster contact surfaces. */
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { type Accessor, type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  compactPrimitive,
  copyToDocument,
  joinPrimitives,
  prune,
  unpartition,
  weld,
} from '@gltf-transform/functions'

import { compressedCharacterTexture } from './character-textures.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const tubeNames = /tube|seam/iu
const recessName = /recess/iu
type FaceGroup = number[]

// glTF UV splits separate positions in storage, even when the artwork is connected.
function connectedFaces(position: Accessor, faces: Uint16Array | Uint32Array): FaceGroup[] {
  const links = Int32Array.from({ length: position.getCount() }, (_unused, index) => index)
  const owner = (index: number): number => {
    const parent = links[index] ?? index
    if (parent !== index) {
      links[index] = owner(parent)
    }
    return links[index] ?? index
  }
  const merge = (a: number, b: number) => {
    links[owner(a)] = owner(b)
  }
  const welded = new Map<string, number>()
  for (let i = 0; i < position.getCount(); i++) {
    const key = position
      .getElement(i, [])
      .map((value) => Math.round(value * 100_000))
      .join(',')
    const first = welded.get(key)
    if (first === undefined) {
      welded.set(key, i)
    } else {
      merge(first, i)
    }
  }
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = faces.subarray(i, i + 3)
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('Revolver surface is not triangular')
    }
    merge(a, b)
    merge(a, c)
  }
  const groups = new Map<number, FaceGroup>()
  for (let i = 0; i < faces.length; i += 3) {
    const index = owner(faces[i] ?? 0)
    const group = groups.get(index) ?? []
    group.push(i)
    groups.set(index, group)
  }
  return [...groups.values()]
}

function remapScan(doc: Document, source: Primitive, fitted: Primitive, vertices: number[]): void {
  const position = fitted.getAttribute('POSITION')
  const uv = fitted.getAttribute('TEXCOORD_0')
  const buffer = position?.getBuffer()
  if (!(position && uv && buffer)) {
    throw new Error('Missing authored revolver scan coordinates')
  }
  const count = position.getCount()
  for (const name of ['TEXCOORD_0', 'TEXCOORD_1']) {
    const scan = source.getAttribute(name)
    if (!scan) {
      throw new Error(`Missing revolver scan ${name}`)
    }
    const bounds = [0, 1].map((axis) => {
      const values = vertices.map((i) => scan.getElement(i, [])[axis] ?? 0)
      return [Math.min(...values), Math.max(...values)]
    })
    const mapped = new Float32Array(count * 2)
    for (let i = 0; i < count; i++) {
      const coord = uv.getElement(i, [])
      for (const axis of [0, 1] as const) {
        const [low = 0, high = 1] = bounds[axis] ?? []
        mapped[i * 2 + axis] = low + (high - low) * (0.035 + (coord[axis] ?? 0) * 0.93)
      }
    }
    fitted.setAttribute(
      name,
      doc.createAccessor().setBuffer(buffer).setType('VEC2').setArray(mapped),
    )
  }
  const tint = fitted.getMaterial()?.getBaseColorFactor()[0] ?? 1
  const originalColor = source.getAttribute('COLOR_0')?.getElement(vertices[0] ?? 0, [])
  if (!originalColor) {
    throw new Error('Missing revolver finish tint')
  }
  const colors = new Float32Array(count * originalColor.length)
  for (let i = 0; i < count; i++) {
    colors.set(
      originalColor.map((value, axis) => (axis < 3 ? tint * value : value)),
      i * originalColor.length,
    )
  }
  fitted.setAttribute(
    'COLOR_0',
    doc
      .createAccessor()
      .setBuffer(buffer)
      .setType(originalColor.length === 3 ? 'VEC3' : 'VEC4')
      .setArray(colors),
  )
}

export async function fitRevolver(source: string, target: string): Promise<void> {
  const [art, doc] = await Promise.all([io.read(source), io.read(target)])
  const mesh = doc.getRoot().listMeshes()[0]
  const old = mesh?.listPrimitives()[0]
  const position = old?.getAttribute('POSITION')
  const index = old?.getIndices()
  const faces = index?.getArray()
  if (
    !(
      mesh &&
      old &&
      position &&
      index &&
      (faces instanceof Uint16Array || faces instanceof Uint32Array)
    )
  ) {
    throw new Error(`Missing native revolver shell for ${target}`)
  }
  const groups = connectedFaces(position, faces)
  const barrel = groups.filter((group) => {
    const reach = Math.max(
      ...group.flatMap((i) =>
        Array.from(faces.subarray(i, i + 3), (vertex) => position.getElement(vertex, [])[0] ?? 0),
      ),
    )
    return (group.length === 96 || group.length === 56) && reach > 0.98
  })
  const tube = groups.filter((group) => {
    const y = position.getElement(faces[group[0] ?? 0] ?? 0, [])[1] ?? 0
    return (group.length === 28 || group.length === 154) && y > 0.15
  })
  if (barrel.length !== 2 || tube.length !== 2) {
    throw new Error(`Could not identify the original exterior surfaces in ${target}`)
  }
  const points = (selected: FaceGroup[]) => [
    ...new Set(
      selected.flatMap((part) => part.flatMap((i) => Array.from(faces.subarray(i, i + 3)))),
    ),
  ]
  const scans = {
    barrel: points(barrel.filter((group) => group.length === 96)),
    crown: points(barrel.filter((group) => group.length === 56)),
    tube: points(tube.filter((group) => group.length === 28)),
  }
  const surfaces = art
    .getRoot()
    .listMeshes()
    .flatMap((entry) => {
      const name = entry.getName()
      const steel = tubeNames.test(name) ? scans.tube : scans.barrel
      const scan = recessName.test(name) ? scans.crown : steel
      return entry.listPrimitives().map((primitive) => ({ primitive, scan }))
    })
  const copied = copyToDocument(
    doc,
    art,
    surfaces.map(({ primitive }) => primitive),
  )
  const fitted = surfaces.map(({ primitive, scan }) => {
    const part = copied.get(primitive) as Primitive
    remapScan(doc, old, part, scan)
    return part.setMaterial(old.getMaterial())
  })
  const retired = new Set([...barrel, ...tube].flat())
  const kept: number[] = []
  for (let i = 0; i < faces.length; i += 3) {
    if (!retired.has(i)) {
      kept.push(...faces.subarray(i, i + 3))
    }
  }
  index.setArray(Uint16Array.from(kept))
  compactPrimitive(old)
  mesh.addPrimitive(joinPrimitives(fitted))
  for (const part of fitted) {
    part.dispose()
  }
  if (basename(target) === 'gun.rusty-six.glb') {
    const finish = old.getMaterial()
    const surface = async (channel: 'albedo' | 'arm' | 'normal') =>
      compressedCharacterTexture(
        await readFile(
          resolve('tools/art/characters/revolver-exteriors', `rusty-six-${channel}.png`),
        ),
        channel === 'albedo',
      )
    if (!finish) {
      throw new Error('Missing fitted starter revolver finish')
    }
    const [albedo, normal, arm] = await Promise.all([
      surface('albedo'),
      surface('normal'),
      surface('arm'),
    ])
    // All three maps share the original five-band finish UVs. Scratches must interrupt
    // the roughness and tilt the normal at the same texel as their exposed metal.
    finish.setExtras({ ...finish.getExtras(), nativePbr: { albedo, normal, arm, armUv: 0 } })
  }
  await doc.transform(weld(), prune({ keepAttributes: true, keepLeaves: true }), unpartition())
  await io.write(target, doc)
}
