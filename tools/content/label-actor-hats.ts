/** Give preserved authored head props an explicit native mount; never rewrite their binary data. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { GLTF } from '@gltf-transform/core'

const MOUNT = 'mount.Head.accessory'
export function labelActorHat(gltf: GLTF.IGLTF): number {
  const nodes = gltf.nodes ?? []
  const joints = new Set(gltf.skins?.flatMap((skin) => skin.joints))
  const head = nodes.findIndex((node, index) => joints.has(index) && node.name === 'Head')
  if (head < 0) {
    throw new Error('Authored actor has no skinned Head joint')
  }
  const hasRigidMesh = (index: number): boolean => {
    const node = nodes[index]
    if (!node || node.skin !== undefined || joints.has(index)) {
      return false
    }
    return node.mesh !== undefined || Boolean(node.children?.some(hasRigidMesh))
  }
  const candidates = (nodes[head]?.children ?? []).filter(hasRigidMesh)
  if (candidates.length !== 1) {
    throw new Error(`Expected one authored rigid head prop, found${candidates.length}`)
  }
  const selected = candidates[0]
  const mount = selected === undefined ? undefined : nodes[selected]
  if (!mount) {
    throw new Error('Missing authored head-prop root')
  }
  mount.name = MOUNT
  return selected ?? -1
}
export function labelActorHatGlb(source: Buffer): { bytes: Buffer; binHash: string; node: number } {
  if (source.readUInt32LE(0) !== 0x46_54_6c_67 || source.readUInt32LE(16) !== 0x4e_4f_53_4a) {
    throw new Error('Expected binary glTF JSON chunk')
  }
  const length = source.readUInt32LE(12)
  const json = JSON.parse(source.subarray(20, 20 + length).toString()) as GLTF.IGLTF
  const expected = structuredClone(json)
  const node = labelActorHat(json)
  const mount = expected.nodes?.[node]
  if (!mount) {
    throw new Error('Missing expected authored head mount')
  }
  mount.name = MOUNT
  if (!isDeepStrictEqual(json, expected)) {
    throw new Error('Hat labeling changed non-name metadata')
  }
  const encoded = Buffer.from(JSON.stringify(json))
  const padded = (encoded.length + 3) & ~3
  const chunk = Buffer.alloc(8 + padded, 0x20)
  chunk.writeUInt32LE(padded, 0)
  chunk.writeUInt32LE(0x4e_4f_53_4a, 4)
  encoded.copy(chunk, 8)
  const binary = source.subarray(20 + length)
  const header = Buffer.from(source.subarray(0, 12))
  header.writeUInt32LE(12 + chunk.length + binary.length, 8)
  const bytes = Buffer.concat([header, chunk, binary])
  if (!bytes.subarray(20 + padded).equals(binary)) {
    throw new Error('Hat labeling changed the binary chunk')
  }
  return { bytes, node, binHash: createHash('sha256').update(binary).digest('hex') }
}
if (import.meta.main) {
  for (const id of ['player', ...Array.from({ length: 17 }, (_, index) => `outlaw-${index}`)]) {
    const source = `tools/art/characters/${id}.gltf`
    const raw = JSON.parse(await readFile(source, 'utf8')) as GLTF.IGLTF
    labelActorHat(raw)
    await writeFile(source, `${JSON.stringify(raw, null, 2)}\n`)
    const path = `public/experiments/out-west/3d/native-v2/baked/${id}.glb`
    const result = labelActorHatGlb(await readFile(path))
    await writeFile(path, result.bytes)
    console.log(JSON.stringify({ id, node: result.node, binHash: result.binHash }))
  }
}
