/** Single-primitive render nodes balance native glTF skin-cache ownership on destruction. */
import { readFile, writeFile } from 'node:fs/promises'
import type { GLTF } from '@gltf-transform/core'

export function normalizeSkinnedNodes(gltf: GLTF.IGLTF): number {
  const nodes = gltf.nodes ?? []
  const meshes = gltf.meshes ?? []
  const split = new Map<number, number[]>()
  let changed = 0
  for (const [index, node] of [...nodes].entries()) {
    const meshIndex = node.mesh
    const mesh = meshIndex === undefined ? undefined : meshes[meshIndex]
    if (
      meshIndex === undefined ||
      !mesh ||
      node.skin === undefined ||
      mesh.primitives.length < 2 ||
      mesh.weights?.length ||
      mesh.primitives.some((primitive) => primitive.targets?.length) ||
      nodes.some(
        (other) =>
          other.mesh === meshIndex && (other.skin === undefined || Boolean(other.weights?.length)),
      )
    ) {
      continue
    }
    let parts = split.get(meshIndex)
    if (!parts) {
      parts = mesh.primitives.map((primitive, part) => {
        const next = meshes.length
        meshes.push({
          ...mesh,
          name: `${mesh.name ?? 'skin'}.part.${part}`,
          primitives: [primitive],
        })
        return next
      })
      split.set(meshIndex, parts)
    }
    const { mesh: _mesh, skin, ...parent } = node
    const children = parts.map((part, primitive) => {
      const child = nodes.length
      nodes.push({ name: `native.skin-part.${index}.${primitive}`, mesh: part, skin })
      return child
    })
    nodes[index] = { ...parent, children: [...(node.children ?? []), ...children] }
    changed++
  }
  if (changed === 0) {
    return 0
  }
  // Preserve shared mesh resources and every unrelated mesh; only replaced, unused entries retire.
  const used = new Set(nodes.flatMap((node) => (node.mesh === undefined ? [] : [node.mesh])))
  const remapped = new Map<number, number>()
  gltf.meshes = meshes.filter((_mesh, index) => {
    if (split.has(index) && !used.has(index)) {
      return false
    }
    remapped.set(index, remapped.size)
    return true
  })
  for (const node of nodes) {
    if (node.mesh !== undefined) {
      const mesh = remapped.get(node.mesh)
      if (mesh === undefined) {
        throw new Error(`Missing glTF mesh ${node.mesh}`)
      }
      node.mesh = mesh
    }
  }
  return changed
}

/** Patch JSON only: accessor storage, compressed images and all remaining chunks stay byte-identical. */
export function normalizeSkinnedGlb(source: Buffer): { bytes: Buffer; nodes: number } {
  if (
    source.length < 20 ||
    source.readUInt32LE(0) !== 0x46_54_6c_67 ||
    source.readUInt32LE(4) !== 2 ||
    source.readUInt32LE(16) !== 0x4e_4f_53_4a
  ) {
    throw new Error('Expected binary glTF 2 JSON chunk')
  }
  const length = source.readUInt32LE(12)
  const json = JSON.parse(source.subarray(20, 20 + length).toString()) as GLTF.IGLTF
  const nodes = normalizeSkinnedNodes(json)
  if (nodes === 0) {
    return { bytes: source, nodes }
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
  return { bytes: Buffer.concat([header, chunk, binary]), nodes }
}

export async function normalizeSkinnedAsset(path: string): Promise<number> {
  const result = normalizeSkinnedGlb(await readFile(path))
  if (result.nodes > 0) {
    await writeFile(path, result.bytes)
  }
  return result.nodes
}

if (import.meta.main) {
  for (const path of process.argv.slice(2)) {
    console.log(`${path}: ${await normalizeSkinnedAsset(path)} skinned nodes normalized`)
  }
}
