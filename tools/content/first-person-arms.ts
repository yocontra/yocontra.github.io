/** Offline semantic selection copies fitted native triangles; runtime only loads ordinary glTF. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import {
  type Accessor,
  type Document,
  type Node,
  NodeIO,
  type Primitive,
  type Skin,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { compactPrimitive, prune } from '@gltf-transform/functions'
import { Mat4, Vec3 } from 'playcanvas'
import type { Range } from './character-atlas.ts'
import { integrateGarmentParts } from './garment-parts.ts'
import { fitWaistcoats } from './waistcoat-fit.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const CELL = 0.0005
// Native default quantization uses 14 position bits and 10 normal bits.
const POSITION_ERROR = 0.0003
const ARM = /^(?:UpperArm|LowerArm|Wrist|(?:Thumb|Index|Middle|Ring|Pinky)\d)[LR]$/u
const FIT = /^(?:outfit\.[a-z-]+(?:\.pair)?|outlaw-\d+|player)$/u
const ATTACHMENT = /^(?:mount\.|socket\.)/u
const SLEEVE = /^(?:WesternSleeves|ContinuousCoatSleeve[LR])$/u
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
interface SourceVertex {
  position: number[]
  normal: number[]
  weights: Map<string, number>
  faces: Set<number>
}
interface SourceFace {
  role: string
  selected: boolean
  side: string
  triangle: number[]
}
interface Selection {
  vertices: SourceVertex[]
  faces: SourceFace[]
  buckets: Map<string, number[]>
  skin: Skin
}
function key(position: number[]): string {
  return position.map((v) => Math.floor(v / CELL)).join('/')
}
function weights(primitive: Primitive, skin: Skin, vertex: number): Map<string, number> {
  const ids = primitive.getAttribute('JOINTS_0')?.getElement(vertex, []) ?? []
  const values = primitive.getAttribute('WEIGHTS_0')?.getElement(vertex, []) ?? []
  const result = new Map<string, number>()
  for (let c = 0; c < values.length; c++) {
    const name = skin.listJoints()[ids[c] ?? 0]?.getName() ?? ''
    result.set(name, (result.get(name) ?? 0) + (values[c] ?? 0))
  }
  return result
}
function armWeight(input: Map<string, number>): number {
  return [...input].reduce((sum, [name, weight]) => sum + (ARM.test(name) ? weight : 0), 0)
}
function selectedFace(
  role: string,
  range: Range | undefined,
  vertices: (SourceVertex | undefined)[],
): boolean {
  if (SLEEVE.test(role) || role === 'Hands') {
    return true
  }
  return (
    (role === 'Skin' || range?.slot === 'skin') &&
    vertices.every((vertex) => vertex && armWeight(vertex.weights) > 0.999)
  )
}
function collectSource(doc: Document): Selection {
  const vertices: SourceVertex[] = []
  const faces: SourceFace[] = []
  const buckets = new Map<string, number[]>()
  let bodySkin: Skin | undefined
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin()
    const mesh = node.getMesh()
    if (!(skin && mesh && skin.listJoints().some((joint) => joint.getName() === 'WristR'))) {
      continue
    }
    bodySkin ??= skin
    for (const primitive of mesh.listPrimitives()) {
      collectPrimitive(node, primitive, skin, { vertices, faces, buckets })
    }
  }
  if (!bodySkin) {
    throw new Error('Missing canonical humanoid skin')
  }
  return { vertices, faces, buckets, skin: bodySkin }
}
function collectPrimitive(
  node: Node,
  primitive: Primitive,
  skin: Skin,
  { vertices, faces, buckets }: Pick<Selection, 'vertices' | 'faces' | 'buckets'>,
): void {
  const position = primitive.getAttribute('POSITION')
  const normal = primitive.getAttribute('NORMAL')
  const indices = primitive.getIndices()
  if (!(position && normal && indices)) {
    throw new Error('Expected indexed source body')
  }
  const ranges = (primitive.getExtras().pieceRanges ??
    node.getExtras().pieceRanges ??
    []) as Range[]
  const offset = vertices.length
  for (let v = 0; v < position.getCount(); v++) {
    const point = position.getElement(v, [])
    vertices.push({
      position: point,
      normal: normal.getElement(v, []),
      weights: weights(primitive, skin, v),
      faces: new Set(),
    })
    const bucket = buckets.get(key(point)) ?? []
    bucket.push(offset + v)
    buckets.set(key(point), bucket)
  }
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [0, 1, 2].map((c) => indices.getScalar(i + c))
    const range = ranges.find((candidate) =>
      triangle.every((v) => v >= candidate.start && v < candidate.start + candidate.count),
    )
    const role = range?.name ?? range?.slot ?? 'unnamed'
    const selected = selectedFace(
      role,
      range,
      triangle.map((v) => vertices[offset + v]),
    )
    const side =
      triangle.reduce((sum, v) => sum + (vertices[offset + v]?.position[0] ?? 0), 0) > 0 ? 'L' : 'R'
    const face = faces.length
    faces.push({ role, selected, side, triangle: triangle.map((v) => v + offset) })
    for (const v of triangle) {
      vertices[offset + v]?.faces.add(face)
    }
  }
}
function weightError(a: Map<string, number>, b: Map<string, number>): number {
  return [...new Set([...a.keys(), ...b.keys()])].reduce(
    (sum, name) => sum + Math.abs((a.get(name) ?? 0) - (b.get(name) ?? 0)),
    0,
  )
}
function matches(
  selection: Selection,
  position: number[],
  normal: number[],
  influence: Map<string, number>,
): number[] {
  const cell = position.map((v) => Math.floor(v / CELL))
  const result: number[] = []
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        for (const id of selection.buckets.get(
          `${(cell[0] ?? 0) + x}/${(cell[1] ?? 0) + y}/${(cell[2] ?? 0) + z}`,
        ) ?? []) {
          const candidate = selection.vertices[id]
          if (
            candidate &&
            Math.hypot(...position.map((v, c) => v - (candidate.position[c] ?? 0))) <=
              POSITION_ERROR &&
            Math.hypot(...normal.map((v, c) => v - (candidate.normal[c] ?? 0))) < 0.004 &&
            weightError(influence, candidate.weights) <= 4 / 255
          ) {
            result.push(id)
          }
        }
      }
    }
  }
  return result
}
function matrix(accessor: Accessor | null, index: number): Mat4 {
  if (!accessor) {
    throw new Error('Missing inverse binds')
  }
  return new Mat4().set(accessor.getElement(index, []))
}
function selectNative(primitive: Primitive, skin: Skin, selection: Selection) {
  const original = selection.skin
    .listJoints()
    .findIndex((j) => j.getName() === skin.listJoints()[0]?.getName())
  if (original < 0) {
    throw new Error('Native skeleton differs from source')
  }
  const decode = matrix(selection.skin.getInverseBindMatrices(), original)
    .invert()
    .mul(matrix(skin.getInverseBindMatrices(), 0))
  const positions = primitive.getAttribute('POSITION')
  const normals = primitive.getAttribute('NORMAL')
  const indices = primitive.getIndices()
  if (!(positions && normals && indices)) {
    throw new Error('Missing native indexed surface')
  }
  const candidates = new Map<number, Set<number>>()
  for (const v of new Set(indices.getArray() ?? [])) {
    const position = decode.transformPoint(new Vec3(...positions.getElement(v, []))).toArray()
    const source = matches(
      selection,
      position,
      normals.getElement(v, []),
      weights(primitive, skin, v),
    )
    candidates.set(v, new Set(source))
  }
  const keep: number[] = []
  const provenance: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [0, 1, 2].map((c) => indices.getScalar(i + c))
    const nearby = new Set(
      [...(candidates.get(triangle[0] ?? -1) ?? [])].flatMap((id) => [
        ...(selection.vertices[id]?.faces ?? []),
      ]),
    )
    const faces = [...nearby].filter((id) => {
      const face = selection.faces[id]
      // A cyclic rotation preserves winding; each native corner must map to its source corner.
      return face?.triangle.some((_, start) =>
        triangle.every((v, corner) =>
          candidates.get(v)?.has(face.triangle[(start + corner) % 3] ?? -1),
        ),
      )
    })
    if (faces.some((id) => selection.faces[id]?.selected)) {
      if (faces.some((id) => !selection.faces[id]?.selected)) {
        throw new Error(`Ambiguous source arm triangle: ${JSON.stringify(faces)}`)
      }
      keep.push(...triangle)
      provenance.push(...faces)
    }
  }
  return { keep, provenance }
}
function filterNative(doc: Document, selection: Selection) {
  const retained = new Set<number>()
  const surfaces: { name: string; triangles: number; vertices: number }[] = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    const skin = node.getSkin()
    if (!mesh) {
      continue
    }
    if (!skin?.listJoints().some((joint) => joint.getName() === 'WristR')) {
      node.setMesh(null)
      continue
    }
    for (const primitive of [...mesh.listPrimitives()]) {
      const { keep, provenance } = selectNative(primitive, skin, selection)
      if (keep.length === 0) {
        mesh.removePrimitive(primitive)
        continue
      }
      for (const face of provenance) {
        if (retained.has(face)) {
          throw new Error(`Duplicate native arm triangle for source face ${face}`)
        }
        retained.add(face)
      }
      const indices = primitive.getIndices()
      if (!indices) {
        throw new Error('Missing native indices')
      }
      primitive.setIndices(indices.clone().setArray(Uint32Array.from(keep)))
      compactPrimitive(primitive)
      surfaces.push({
        name: primitive.getMaterial()?.getName() ?? '',
        triangles: keep.length / 3,
        vertices: primitive.getAttribute('POSITION')?.getCount() ?? 0,
      })
    }
    if (mesh.listPrimitives().length === 0) {
      node.setMesh(null)
    }
  }
  return { retained, surfaces }
}
export async function extractFirstPersonArms(id: string) {
  if (!FIT.test(id)) {
    throw new Error(`Invalid humanoid fit ${id}`)
  }
  const sourcePath = resolve('tools/art/characters', `${id}.gltf`)
  const sourceBytes = await readFile(sourcePath)
  const sourceJson = JSON.parse(sourceBytes.toString()) as { buffers: { uri: string }[] }
  const sourceBufferPaths = sourceJson.buffers.map((buffer) =>
    resolve(dirname(sourcePath), buffer.uri),
  )
  const source = await io.read(sourcePath)
  const authoredPaths = ['coat-sleeves', 'boot-bridges', 'coat-collars', 'shirt-fronts'].map(
    (category) => resolve('tools/art/characters', category, `${id}.glb`),
  )
  if (
    source
      .getRoot()
      .listMeshes()
      .some((mesh) => mesh.listPrimitives().some((primitive) => primitive.getExtras().waistcoatFit))
  ) {
    authoredPaths.push(resolve('tools/art/characters/waistcoats', `${id}.glb`))
  }
  const authoredInputs: string[] = []
  for (const path of authoredPaths) {
    if (await Bun.file(path).exists()) {
      authoredInputs.push(path)
    }
  }
  await integrateGarmentParts(source, id)
  await fitWaistcoats(source, id)
  const selection = collectSource(source)
  const nativePath = resolve(
    'public/experiments/out-west/3d/native-v2',
    id.startsWith('outfit.') ? 'equipment' : 'baked',
    `${id}.glb`,
  )
  const nativeBytes = await readFile(nativePath)
  const doc = await io.readBinary(nativeBytes)
  const { retained, surfaces } = filterNative(doc, selection)
  const wanted = selection.faces.flatMap((face, index) => (face.selected ? [index] : []))
  const missing = wanted.filter((face) => !retained.has(face))
  if (missing.length > 0) {
    const examples = missing.slice(0, 12).map((i) => ({
      face: selection.faces[i],
      positions: selection.faces[i]?.triangle.map((v) => selection.vertices[v]?.position),
    }))
    throw new Error(
      `Missing ${missing.length}/${wanted.length} source arm faces for ${id}: ${JSON.stringify(examples)}`,
    )
  }
  for (const animation of [...doc.getRoot().listAnimations()]) {
    if (animation.getName().startsWith('Weapon_')) {
      animation.dispose()
    }
  }
  for (const node of [...doc.getRoot().listNodes()]) {
    if (ATTACHMENT.test(node.getName())) {
      node.dispose()
    }
  }
  const sourceBuffers = await Promise.all(sourceBufferPaths.map((path) => readFile(path)))
  const sourceInputs = await Promise.all(
    [
      sourcePath,
      ...sourceBufferPaths,
      nativePath,
      ...authoredInputs,
      import.meta.path,
      ...[
        'garment-parts.ts',
        'garment-geometry.ts',
        'waistcoat-fit.ts',
        'waistcoat-pattern.json',
        'authoring-inputs.ts',
      ].map((helper) => resolve(import.meta.dir, helper)),
    ]
      .toSorted((a, b) => a.localeCompare(b))
      .map(async (path) => ({
        path: relative(process.cwd(), path),
        sha256: hash(await readFile(path)),
      })),
  )
  const nativeHash = hash(nativeBytes)
  const provenance = {
    fit: id,
    nativePath: relative(process.cwd(), nativePath),
    nativeSHA256: nativeHash,
    canonicalSHA256: hash(Buffer.concat([sourceBytes, ...sourceBuffers])),
    helperSHA256: hash(await readFile(import.meta.path)),
    sourceInputs,
    sourceFaces: wanted.length,
    retainedFaces: retained.size,
    surfaces,
  }
  doc.getRoot().setExtras({ ...doc.getRoot().getExtras(), firstPersonArms: provenance })
  await doc.transform(prune({ keepAttributes: true, keepLeaves: true }))
  const bytes = await io.writeBinary(doc)
  return {
    bytes,
    report: {
      ...provenance,
      bytes: bytes.length,
      hash: hash(bytes),
      buffers: doc.getRoot().listBuffers().length,
    },
  }
}
if (import.meta.main) {
  const output = process.argv[process.argv.indexOf('--out') + 1]
  if (!(process.argv.includes('--out') && output)) {
    throw new Error('Supply --out staging-directory')
  }
  await mkdir(output, { recursive: true })
  const ids = process.env.OUT_WEST_CHARACTERS?.split(',') ?? [
    'outfit.trail-duds',
    'outfit.wool-duster',
  ]
  const reports: Awaited<ReturnType<typeof extractFirstPersonArms>>['report'][] = []
  for (const id of ids) {
    const { bytes, report } = await extractFirstPersonArms(id)
    await writeFile(resolve(output, `${basename(id)}.glb`), bytes)
    reports.push(report)
    console.log(JSON.stringify(report))
  }
  await writeFile(resolve(output, 'inventory.json'), `${JSON.stringify(reports, null, 2)}\n`)
}
