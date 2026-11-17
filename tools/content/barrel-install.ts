/** Append only owned barrel streams; old scene JSON/resources/BIN stay in place. */
import { Buffer } from 'node:buffer'
import type { Document, GLTF, Mesh } from '@gltf-transform/core'
import { Mat4, Quat, Vec3 } from 'playcanvas'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'
import { validateAuthoringInputs } from './authoring-inputs.ts'
import { readMountGlb } from './frontier-mounts-install.ts'

type Glb = ReturnType<typeof readMountGlb>
const sha256Digest = /^[a-f0-9]{64}$/u
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Incomplete authored barrel data')
  }
  return value
}
function pack(json: GLTF.IGLTF, bin: Buffer): Buffer {
  const text = Buffer.from(JSON.stringify(json))
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(20)
  const binary = Buffer.alloc(8)
  header.writeUInt32LE(0x46_54_6c_67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + padded.length + bin.length, 8)
  header.writeUInt32LE(padded.length, 12)
  header.writeUInt32LE(0x4e_4f_53_4a, 16)
  binary.writeUInt32LE(bin.length, 0)
  binary.writeUInt32LE(0x00_4e_49_42, 4)
  return Buffer.concat([header, padded, binary, bin])
}
function worldMatrices(json: Glb['json']) {
  const parents = new Map<number, number>()
  for (const [parent, node] of json.nodes.entries()) {
    for (const child of node.children ?? []) {
      if (parents.has(child)) {
        throw new Error('Ambiguous scene parent')
      }
      parents.set(child, parent)
    }
  }
  const matrix = (index: number, visiting = new Set<number>()): Mat4 => {
    if (visiting.has(index)) {
      throw new Error('Cyclic scene parent')
    }
    visiting.add(index)
    const node = required(json.nodes[index])
    const local = node.matrix
      ? new Mat4().set(node.matrix)
      : new Mat4().setTRS(
          new Vec3(...(node.translation ?? [0, 0, 0])),
          new Quat(...(node.rotation ?? [0, 0, 0, 1])),
          new Vec3(...(node.scale ?? [1, 1, 1])),
        )
    const parent = parents.get(index)
    return parent === undefined ? local : matrix(parent, visiting).mul(local)
  }
  return matrix
}
function barrelTargets(json: Glb['json']) {
  return ENVIRONMENT_PROPS.map((prop) => {
    const matches = json.nodes.filter((node) =>
      Object.entries(prop.binding).every(
        ([field, value]) => JSON.stringify(Reflect.get(node, field)) === JSON.stringify(value),
      ),
    )
    if (matches.length !== 1) {
      throw new Error(`Missing unique canonical barrel ${prop.id}`)
    }
    const owner = required(matches[0])
    const targets: GLTF.INode[] = []
    const walk = (node: GLTF.INode) => {
      if (node.mesh !== undefined) {
        targets.push(node)
      }
      for (const child of node.children ?? []) {
        walk(required(json.nodes[child]))
      }
    }
    walk(owner)
    if (targets.length !== 1) {
      throw new Error('Changed authored barrel hierarchy')
    }
    const target = required(targets[0])
    const oldMesh = required(json.meshes[required(target.mesh)])
    const oldPrimitive = required(oldMesh.primitives[0])
    if (
      oldMesh.primitives.length !== 1 ||
      oldPrimitive.targets ||
      (oldPrimitive.mode !== undefined && oldPrimitive.mode !== 4) ||
      target.matrix ||
      target.translation ||
      target.rotation ||
      target.scale
    ) {
      throw new Error('Changed barrel donor decode frame')
    }
    const material = oldPrimitive.material
    if (material === undefined || json.materials[material]?.name !== 'Kit') {
      throw new Error('Changed donor barrel PBR')
    }
    return { owner, node: target, oldMesh, oldPrimitive, prop }
  })
}
function cloudUv(library: Glb, pos: GLTF.IAccessor, transform: Mat4): Float32Array {
  const originalView = required(library.json.bufferViews[required(pos.bufferView)])
  const values = new DataView(library.bin.buffer, library.bin.byteOffset, library.bin.byteLength)
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const offset =
      (originalView.byteOffset ?? 0) + (pos.byteOffset ?? 0) + i * (originalView.byteStride ?? 12)
    const p = transform.transformPoint(
      new Vec3(
        values.getFloat32(offset, true),
        values.getFloat32(offset + 4, true),
        values.getFloat32(offset + 8, true),
      ),
    )
    uv[i * 2] = p.x / 1024
    uv[i * 2 + 1] = p.z / 1024
  }
  return uv
}
export function appendBarrelVariants(
  source: Uint8Array,
  parts: Uint8Array,
  nativeSourceHash?: string,
): Buffer {
  const { json, bin } = readMountGlb(source)
  const library = readMountGlb(parts)
  const native = nativeSourceHash !== undefined
  if (
    native &&
    (!sha256Digest.test(nativeSourceHash) || typeof json.extras?.frontierSourceHash !== 'string')
  ) {
    throw new Error('Missing native source link')
  }
  const tallNode = library.json.nodes.find((node) => node.name === 'barrel-tall')
  const tall =
    tallNode?.mesh === undefined ? undefined : library.json.meshes[tallNode.mesh]?.primitives[0]
  if (!(tall && tall.indices !== undefined)) {
    throw new Error('Missing authored tall barrel')
  }
  const pos = library.json.accessors[required(tall.attributes.POSITION)]
  if (pos?.componentType !== 5126 || pos.type !== 'VEC3' || pos.bufferView === undefined) {
    throw new Error('Expected authored Float32 barrel positions')
  }
  const matrix = worldMatrices(json)
  const targets = barrelTargets(json)
  const chunks = [bin]
  const viewCopies = new Map<number, number>()
  const accessorCopies = new Map<number, number>()
  let size = bin.length
  const view = (data: Buffer, fields: Partial<GLTF.IBufferView> = {}) => {
    const offset = size
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)])
    chunks.push(padded)
    size += padded.length
    json.bufferViews.push({ ...fields, buffer: 0, byteOffset: offset, byteLength: data.length })
    return json.bufferViews.length - 1
  }
  const copyAccessor = (index: number) => {
    const cached = accessorCopies.get(index)
    if (cached !== undefined) {
      return cached
    }
    const accessor = required(library.json.accessors[index])
    if (accessor.bufferView === undefined || accessor.sparse) {
      throw new Error('Unexpected sparse barrel stream')
    }
    let target = viewCopies.get(accessor.bufferView)
    if (target === undefined) {
      const original = required(library.json.bufferViews[accessor.bufferView])
      const start = original.byteOffset ?? 0
      target = view(library.bin.subarray(start, start + original.byteLength), original)
      viewCopies.set(accessor.bufferView, target)
    }
    json.accessors.push({ ...accessor, bufferView: target })
    const result = json.accessors.length - 1
    accessorCopies.set(index, result)
    return result
  }
  const attributes = Object.fromEntries(
    Object.entries(tall.attributes)
      .filter(([name]) => name !== 'TEXCOORD_1')
      .map(([name, index]) => [name, copyAccessor(index)]),
  )
  const indices = copyAccessor(tall.indices)
  let canonicalMesh: number | undefined
  for (const { owner, node, oldMesh, oldPrimitive, prop } of targets) {
    owner.name = prop.root
    owner.extras = { ...owner.extras, environmentProp: prop.id }
    const data = { ...attributes }
    if (native) {
      const uv = cloudUv(library, pos, matrix(json.nodes.indexOf(node)))
      json.accessors.push({
        componentType: 5126,
        count: pos.count,
        type: 'VEC2',
        bufferView: view(Buffer.from(uv.buffer), { target: 34_962 }),
      })
      data.TEXCOORD_1 = json.accessors.length - 1
    } else if (tall.attributes.TEXCOORD_1 !== undefined) {
      data.TEXCOORD_1 = copyAccessor(tall.attributes.TEXCOORD_1)
    }
    const mesh = {
      ...oldMesh,
      name: 'Authored tall responsive barrel',
      primitives: [{ ...oldPrimitive, attributes: data, indices }],
    }
    if (!native && canonicalMesh !== undefined) {
      node.mesh = canonicalMesh
    } else if (native && json.nodes.filter((n) => n.mesh === node.mesh).length === 1) {
      json.meshes[required(node.mesh)] = mesh
    } else {
      json.meshes.push(mesh)
      node.mesh = json.meshes.length - 1
      if (!native) {
        canonicalMesh = node.mesh
      }
    }
  }
  if (native) {
    required(json.extras).frontierSourceHash = nativeSourceHash
  }
  json.buffers[0].byteLength = size
  return pack(json, Buffer.concat(chunks))
}

/** Normal future map builds reuse the persisted tall prefab; no DCC process is needed. */
export async function installBarrelParts(doc: Document, library: Document): Promise<void> {
  await validateAuthoringInputs(library)
  const { cloneDocument, mergeDocuments, prune } = await import('@gltf-transform/functions')
  const copy = cloneDocument(library)
  for (const node of copy.getRoot().listNodes()) {
    if (node.getName() !== 'barrel-tall') {
      node.dispose()
    }
  }
  await copy.transform(
    prune({ keepLeaves: true, keepAttributes: true, keepIndices: true, keepSolidTextures: true }),
  )
  const source = copy
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'barrel-tall')
  if (!source?.getMesh()) {
    throw new Error('Missing persisted barrel source')
  }
  const imported = mergeDocuments(doc, copy)
  const mesh = imported.get(required(source.getMesh())) as Mesh
  const kit = doc
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === 'Kit')
  if (!kit) {
    throw new Error('Missing donor barrel PBR')
  }
  const placeholders = mesh
    .listPrimitives()
    .flatMap((p) => (p.getMaterial() ? [required(p.getMaterial())] : []))
  for (const primitive of mesh.listPrimitives()) {
    primitive.setMaterial(kit)
  }
  for (const prop of ENVIRONMENT_PROPS) {
    const root = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === prop.root)
    if (!root) {
      throw new Error('Missing responsive barrel binding')
    }
    const targets: import('@gltf-transform/core').Node[] = []
    root.traverse((node) => {
      if (node.getMesh()) {
        targets.push(node)
      }
    })
    if (targets.length !== 1) {
      throw new Error('Changed barrel mesh hierarchy')
    }
    required(targets[0]).setMesh(mesh)
  }
  for (const scene of copy.getRoot().listScenes()) {
    imported.get(scene)?.dispose()
  }
  imported.get(source)?.dispose()
  for (const placeholder of placeholders) {
    placeholder.dispose()
  }
}
