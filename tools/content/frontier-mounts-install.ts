/** Add new ironwork while retaining every existing JSON array entry and BIN byte in place. */
import { Buffer } from 'node:buffer'
import type { GLTF } from '@gltf-transform/core'
import { calculateNormals, calculateTangents } from 'playcanvas'
import {
  type FrontierMount,
  type FrontierMountGroup,
  groupFrontierMounts,
  MOUNT_IRON_TINT,
} from './frontier-mounts.ts'

import { FRONTIER_IRON } from './frontier-surfaces.ts'

type MountGlb = GLTF.IGLTF &
  Required<
    Pick<GLTF.IGLTF, 'accessors' | 'bufferViews' | 'nodes' | 'meshes' | 'materials' | 'scenes'>
  > & { buffers: [GLTF.IBuffer] }
type Values = Float32Array | Uint16Array | Uint32Array
type Shape = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4'
const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const hashPattern = /^[a-f0-9]{64}$/u

export function readMountGlb(source: Uint8Array): { json: MountGlb; bin: Buffer } {
  const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  if (
    bytes.length < 20 ||
    bytes.readUInt32LE(0) !== 0x46_54_6c_67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  ) {
    throw new Error('Invalid GLB header')
  }
  let json: MountGlb | undefined
  let bin: Buffer | undefined
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (chunk.length !== length) {
      throw new Error('Truncated GLB chunk')
    }
    if (type === 0x4e_4f_53_4a) {
      json = JSON.parse(chunk.toString('utf8')) as MountGlb
    } else if (type === 0x00_4e_49_42) {
      bin = chunk
    } else {
      throw new Error('Unsupported extra GLB chunk')
    }
    offset += 8 + length
  }
  if (!(json && bin && json.buffers?.length === 1 && !json.buffers[0].uri)) {
    throw new Error('Mount append requires one embedded GLB buffer')
  }
  for (const key of [
    'accessors',
    'bufferViews',
    'nodes',
    'meshes',
    'materials',
    'scenes',
  ] as const) {
    if (!Array.isArray(json[key])) {
      throw new Error(`Missing GLB ${key}`)
    }
  }
  return { json, bin }
}

function pack(json: MountGlb, bin: Buffer): Buffer {
  const text = Buffer.from(JSON.stringify(json))
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46_54_6c_67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + padded.length + bin.length, 8)
  header.writeUInt32LE(padded.length, 12)
  header.writeUInt32LE(0x4e_4f_53_4a, 16)
  const binary = Buffer.alloc(8)
  binary.writeUInt32LE(bin.length, 0)
  binary.writeUInt32LE(0x00_4e_49_42, 4)
  return Buffer.concat([header, padded, binary, bin])
}

function positionBounds(values: Values, maximum: boolean): number[] {
  return Array.from({ length: 3 }, (_, axis) => {
    let value = maximum ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
    for (let i = axis; i < values.length; i += 3) {
      value = maximum ? Math.max(value, values[i] ?? value) : Math.min(value, values[i] ?? value)
    }
    return value
  })
}

function accessorWriter(json: MountGlb, bin: Buffer) {
  const chunks = [bin]
  let offset = bin.length
  const add = (values: Values, type: Shape, name: string) => {
    const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength)
    const view = json.bufferViews.length
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length })
    const padding = (4 - (bytes.length % 4)) % 4
    chunks.push(bytes, Buffer.alloc(padding))
    offset += bytes.length + padding
    let componentType: GLTF.AccessorComponentType = 5125
    if (values instanceof Float32Array) {
      componentType = 5126
    } else if (values instanceof Uint16Array) {
      componentType = 5123
    }
    const entry: GLTF.IAccessor = {
      name,
      bufferView: view,
      componentType,
      count: values.length / widths[type],
      type,
    }
    if (name.endsWith(':POSITION')) {
      entry.min = positionBounds(values, false)
      entry.max = positionBounds(values, true)
    }
    const index = json.accessors.length
    json.accessors.push(entry)
    return index
  }
  return {
    add,
    finish: () => {
      json.buffers[0].byteLength = offset
      return Buffer.concat(chunks)
    },
  }
}

function ironMesh(
  group: FrontierMountGroup,
  context: {
    add: ReturnType<typeof accessorWriter>['add']
    material: number
  },
): GLTF.IMesh {
  const { positions, indices, owner } = group
  const normals = calculateNormals(positions, indices)
  const uv0: number[] = []
  const uv1: number[] = []
  const colors: number[] = []
  for (let i = 0; i < positions.length; i += 3) {
    const nx = Math.abs(normals[i] ?? 0)
    const ny = Math.abs(normals[i + 1] ?? 0)
    const nz = Math.abs(normals[i + 2] ?? 0)
    uv0.push(
      (positions[i + (nx > nz ? 2 : 0)] ?? 0) / 1.8,
      (positions[i + (ny > Math.max(nx, nz) ? 2 : 1)] ?? 0) / 1.8,
    )
    uv1.push((positions[i] ?? 0) / 1024, (positions[i + 2] ?? 0) / 1024)
    colors.push(...MOUNT_IRON_TINT, 1)
  }
  const name = `Perdition structural iron:${owner}`
  const { add } = context
  const attributes = {
    POSITION: add(new Float32Array(positions), 'VEC3', `${name}:POSITION`),
    NORMAL: add(new Float32Array(normals), 'VEC3', `${name}:NORMAL`),
    TANGENT: add(
      new Float32Array(calculateTangents(positions, normals, uv0, indices)),
      'VEC4',
      `${name}:TANGENT`,
    ),
    TEXCOORD_0: add(new Float32Array(uv0), 'VEC2', `${name}:UV0`),
    TEXCOORD_1: add(new Float32Array(uv1), 'VEC2', `${name}:world-cloud-UV1`),
    COLOR_0: add(new Float32Array(colors), 'VEC4', `${name}:COLOR0`),
  }
  const index = add(
    positions.length / 3 < 65_536 ? new Uint16Array(indices) : new Uint32Array(indices),
    'SCALAR',
    `${name}:indices`,
  )
  return {
    name,
    primitives: [{ attributes, indices: index, material: context.material }],
    extras: { mountParts: group.parts },
  }
}

export function appendFrontierMounts(
  source: Uint8Array,
  members: readonly FrontierMount[],
  nativeSourceHash?: string,
): Buffer {
  const { json, bin } = readMountGlb(source)
  if (json.nodes.some((node) => node.name?.startsWith('Perdition structural iron:'))) {
    throw new Error('Structural mounts are already installed')
  }
  const material = json.materials.findIndex((entry) => entry.name === 'Perdition iron')
  const scene = json.scenes[json.scene ?? 0]
  if (!(material >= 0 && scene?.nodes)) {
    throw new Error('Missing existing iron material/scene roots')
  }
  const iron = json.materials[material]
  if (!iron) {
    throw new Error('Missing iron material')
  }
  iron.pbrMetallicRoughness ??= {}
  iron.pbrMetallicRoughness.baseColorFactor = [...FRONTIER_IRON.baseColor]
  iron.pbrMetallicRoughness.metallicFactor = FRONTIER_IRON.metallic
  if (nativeSourceHash !== undefined) {
    if (
      !hashPattern.test(nativeSourceHash) ||
      typeof json.extras?.frontierSourceHash !== 'string'
    ) {
      throw new Error('Native source link must already exist')
    }
    json.extras.frontierSourceHash = nativeSourceHash
  }
  const writer = accessorWriter(json, bin)
  for (const group of groupFrontierMounts(members)) {
    json.meshes.push(ironMesh(group, { add: writer.add, material }))
    const node = json.nodes.length
    json.nodes.push({
      name: `Perdition structural iron:${group.owner}`,
      mesh: json.meshes.length - 1,
    })
    scene.nodes.push(node)
  }
  return pack(json, writer.finish())
}
