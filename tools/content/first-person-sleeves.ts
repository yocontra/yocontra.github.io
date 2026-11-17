/** Restore the fitted linen topology that the outer poncho's source export trimmed away. */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ComponentTypeToTypedArray, Document, NodeIO } from '@gltf-transform/core'
import type { Range } from './character-atlas.ts'

function check(value: unknown, message = 'Incompatible fitted linen source'): asserts value {
  if (!value) {
    throw new Error(message)
  }
}
function equal(a: unknown, b: unknown, message?: string): void {
  check(isDeepStrictEqual(a, b), message)
}
const io = new NodeIO()
export const FIRST_PERSON_SLEEVE_DONORS = {
  'outfit.striped-poncho': 'outfit.shirt-vest',
  'outfit.striped-poncho.pair': 'outfit.shirt-vest',
  'outlaw-6': 'outfit.shirt-vest',
  'outlaw-15': 'outlaw-2',
} as const
const ids = Object.keys(FIRST_PERSON_SLEEVE_DONORS)
const directory = 'tools/art/characters'
function body(doc: Document) {
  for (const [nodeIndex, node] of doc.getRoot().listNodes().entries()) {
    const mesh = node.getMesh()
    const skin = node.getSkin()
    if (!(mesh && skin)) {
      continue
    }
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const ranges = (primitive.getExtras().pieceRanges ??
        node.getExtras().pieceRanges ??
        []) as Range[]
      const range = ranges.find((piece) => piece.name === 'WesternSleeves')
      if (range) {
        return {
          node,
          skin,
          primitive,
          range,
          sourcePrimitive: {
            nodeIndex,
            meshIndex: doc.getRoot().listMeshes().indexOf(mesh),
            primitiveIndex,
          },
        }
      }
    }
  }
  throw new Error('Missing fitted WesternSleeves')
}
function sleeveIndices(input: ReturnType<typeof body>): number[] {
  const indices = input.primitive.getIndices()
  check(indices)
  const result: number[] = []
  for (let i = 0; i < indices.getCount(); i += 3) {
    const triangle = [0, 1, 2].map((c) => indices.getScalar(i + c))
    if (
      triangle.every((v) => v >= input.range.start && v < input.range.start + input.range.count)
    ) {
      result.push(...triangle.map((v) => v - input.range.start))
    }
  }
  return result
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function sourceFiles(id: string): Promise<string[]> {
  const path = `${directory}/${id}.gltf`
  const doc = JSON.parse(await readFile(path, 'utf8')) as { buffers: { uri: string }[] }
  return [path, ...doc.buffers.map((buffer) => `${directory}/${buffer.uri}`)]
}
export async function authorFirstPersonSleeves(id: string): Promise<Document> {
  check(
    ids.some((name) => name === id),
    'Only the four fitted capes use this source patch',
  )
  const donorId = FIRST_PERSON_SLEEVE_DONORS[id as keyof typeof FIRST_PERSON_SLEEVE_DONORS]
  check(donorId)
  const source = await io.read(`${directory}/${id}.gltf`)
  const donor = await io.read(`${directory}/${donorId}.gltf`)
  const own = body(source)
  const complete = body(donor)
  equal(own.range.count, complete.range.count)
  for (const name of ['UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR', 'WristL', 'WristR']) {
    check(own.skin.listJoints().some((joint) => joint.getName() === name))
    check(complete.skin.listJoints().some((joint) => joint.getName() === name))
  }
  // UV correspondence and retained winding establish the topology mapping across each body.
  // Body dimensions, normals and bone weights stay those of the target, not the donor.
  const ownUv = own.primitive.getAttribute('TEXCOORD_0')
  const donorUv = complete.primitive.getAttribute('TEXCOORD_0')
  check(ownUv && donorUv)
  const side = (input: ReturnType<typeof body>, vertex: number): string => {
    const joint = input.primitive.getAttribute('JOINTS_0')
    const weight = input.primitive.getAttribute('WEIGHTS_0')
    check(joint && weight)
    let left = 0
    let right = 0
    for (const [c, jointId] of joint.getElement(vertex, []).entries()) {
      const name = input.skin.listJoints()[jointId]?.getName() ?? ''
      const influence = weight.getElement(vertex, [])[c] ?? 0
      if (name.endsWith('L')) {
        left += influence
      }
      if (name.endsWith('R')) {
        right += influence
      }
    }
    check(left !== right, 'Sleeve vertex has no unambiguous body side')
    return left > right ? 'L' : 'R'
  }
  for (let v = 0; v < own.range.count; v++) {
    equal(
      ownUv.getElement(own.range.start + v, []),
      donorUv.getElement(complete.range.start + v, []),
      `${id}/sleeve UV/${v}`,
    )
    equal(
      side(own, own.range.start + v),
      side(complete, complete.range.start + v),
      `${id}/sleeve side/${v}`,
    )
  }
  const indices = sleeveIndices(complete)
  const triangleKey = (a: number[]) =>
    [0, 1, 2]
      .map((c) => [...a.slice(c), ...a.slice(0, c)].join('/'))
      .sort((left, right) => left.localeCompare(right))[0]
  const faces = new Set(
    Array.from({ length: indices.length / 3 }, (_, i) =>
      triangleKey(indices.slice(i * 3, i * 3 + 3)),
    ),
  )
  equal(faces.size, indices.length / 3, 'Donor sleeves contain duplicate faces')
  const old = sleeveIndices(own)
  for (let i = 0; i < old.length; i += 3) {
    check(
      faces.has(triangleKey(old.slice(i, i + 3))),
      'Poncho sleeve topology differs from its fitted donor',
    )
  }
  const selected = [own.range]
  // Ordinary portable glTF adds no rig or material duplication.
  const doc = new Document()
  const buffer = doc.createBuffer()
  const primitive = doc.createPrimitive()
  for (const semantic of own.primitive.listSemantics()) {
    const attribute = own.primitive.getAttribute(semantic)
    check(attribute)
    const array = attribute.getArray()
    check(array)
    const width = attribute.getElementSize()
    const ArrayType = ComponentTypeToTypedArray[attribute.getComponentType()]
    check(ArrayType)
    const values = new ArrayType(selected.reduce((sum, range) => sum + range.count, 0) * width)
    let cursor = 0
    for (const range of selected) {
      const part = array.slice(range.start * width, (range.start + range.count) * width)
      values.set(part, cursor)
      cursor += part.length
    }
    let authored = semantic
    if (semantic === 'JOINTS_0') {
      authored = '_AUTHOR_JOINTS'
    } else if (semantic === 'WEIGHTS_0') {
      authored = '_AUTHOR_WEIGHTS'
    } else if (!['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(semantic)) {
      authored = `_AUTHOR${semantic.startsWith('_') ? semantic : `_${semantic}`}`
    }
    primitive.setAttribute(
      authored,
      doc
        .createAccessor()
        .setType(attribute.getType())
        .setNormalized(attribute.getNormalized())
        .setArray(values)
        .setBuffer(buffer),
    )
  }
  primitive.setIndices(
    doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(buffer),
  )
  primitive.setExtras({ pieceRanges: [{ ...own.range, start: 0 }] })
  doc.createScene().addChild(doc.createNode(id).setMesh(doc.createMesh().addPrimitive(primitive)))
  const ownPaths = await sourceFiles(id)
  const paths = [
    ...ownPaths,
    ...(await sourceFiles(donorId)),
    'tools/content/first-person-sleeves.ts',
    'bun.lock',
  ].sort((a, b) => a.localeCompare(b))
  doc.getRoot().setExtras({
    sourceId: id,
    sourceSHA256: sha(Buffer.concat(await Promise.all(ownPaths.map((path) => readFile(path))))),
    sourcePrimitive: own.sourcePrimitive,
    jointNames: own.skin.listJoints().map((j) => j.getName()),
    replaceRanges: selected,
    preserveRangeOrder: true,
    removeTriangles: [],
    authoring:
      'Complete fitted linen sleeves for the first-person presentation; world occlusion geometry stays unchanged',
    sourceInputs: await Promise.all(
      paths.map(async (path) => ({ path, sha256: sha(await readFile(path)) })),
    ),
  })
  return doc
}
if (import.meta.main) {
  for (const id of ids) {
    const path = resolve(directory, 'first-person-sleeves', `${id}.glb`)
    await mkdir(dirname(path), { recursive: true })
    await io.write(path, await authorFirstPersonSleeves(id))
    console.log(`Restored portable linen sleeves: ${id}`)
  }
}
