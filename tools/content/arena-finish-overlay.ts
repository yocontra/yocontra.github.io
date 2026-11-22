/** Apply authored surface maps to released, post-bake arena models. */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type Accessor, type Document, Material, NodeIO, type Texture } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument } from '@gltf-transform/functions'
import { applyArenaFacadeWear } from './arena-facade-wear.ts'

const [source, regularBake, civicMapBake, output] = process.argv.slice(2)
if (!(source && regularBake && civicMapBake && output) || resolve(source) === resolve(output)) {
  throw new Error(
    'Supply distinct staged directories: BASELINE_GLBS REGULAR_BAKED_GLBS CIVIC_MAP_GLBS OUTPUT_GLBS',
  )
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const labels = {
  duel: ['kit-5', 'walls-7', 'ground-18'],
  depot: ['kit-6', 'walls-0', 'trim-1'],
  mission: ['adobe-6', 'masonry-7'],
  bank: ['kit-5', 'walls-0', 'masonry-3'],
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function sum(accessor: Accessor | null | undefined) {
  const array = accessor?.getArray()
  return array ? digest(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)) : null
}
function maps(material: Material) {
  return [
    material.getBaseColorTexture(),
    material.getNormalTexture(),
    material.getMetallicRoughnessTexture(),
    material.getOcclusionTexture(),
  ] as const
}
function textures(material: Material) {
  return maps(material).filter((m): m is Texture => m !== null)
}
function snapshot(doc: Document, owned: readonly string[]) {
  return doc
    .getRoot()
    .listNodes()
    .map((node) => ({
      node: node.getName(),
      parent: node.getParentNode()?.getName(),
      transform: node.getMatrix(),
      extras: node.getExtras(),
      geometry: node
        .getMesh()
        ?.listPrimitives()
        .map((part) => {
          const editable = owned.includes(node.getName())
          const material = part.getMaterial()
          return {
            indices: sum(part.getIndices()),
            streams: part
              .listSemantics()
              .filter((name) => !(editable && ['COLOR_0', 'TEXCOORD_0'].includes(name)))
              .map((name) => [name, sum(part.getAttribute(name))]),
            maps:
              material && !editable
                ? textures(material).map((texture) => {
                    const image = texture.getImage()
                    return image ? digest(image) : null
                  })
                : null,
            material: material && !editable ? material.getBaseColorFactor() : null,
          }
        }),
    }))
}

await mkdir(output, { recursive: true })
for (const name of ['duel', 'depot', 'mission', 'bank'] as const) {
  const filename = `${name}.glb`
  const wholeStage = name === 'duel' || name === 'depot'
  const native = await io.read(join(source, filename))
  const authored = await io.read(join(wholeStage ? regularBake : civicMapBake, filename))
  const owned = labels[name]
  const baseline = snapshot(native, owned)
  const root = native.getRoot()
  const nodes = root.listNodes().filter((node) => owned.includes(node.getName()))
  if (nodes.length !== owned.length) {
    throw new Error(`Unexpected facade node count for ${name}`)
  }
  const orphanedMaterials = new Set<Material>()
  const orphanedTextures = new Set<Texture>()
  const orphanedStreams = new Set<Accessor>()
  for (const node of nodes) {
    for (const part of node.getMesh()?.listPrimitives() ?? []) {
      const material = part.getMaterial()
      if (!material) {
        throw new Error(`Missing ${name} facade material`)
      }
      orphanedMaterials.add(material)
      for (const texture of textures(material)) {
        orphanedTextures.add(texture)
      }
      const shade = part.getAttribute('COLOR_0')
      if (shade) {
        orphanedStreams.add(shade)
      }
    }
  }
  await applyArenaFacadeWear(native, name, { paintOnly: true })
  const revisedRoot = authored.getRoot()
  let replaced = 0
  for (const label of owned) {
    const node = nodes.find((entry) => entry.getName() === label)
    for (const part of node?.getMesh()?.listPrimitives() ?? []) {
      const material = part.getMaterial()
      if (!material) {
        throw new Error(`Missing ${name} facade material`)
      }
      let revision: Material | null | undefined
      if (wholeStage && !label.startsWith('kit-') && !label.startsWith('trim-')) {
        const authoredPart = revisedRoot
          .listNodes()
          .find((entry) => entry.getName() === label)
          ?.getMesh()
          ?.listPrimitives()[0]
        if (!authoredPart || sum(part.getIndices()) !== sum(authoredPart.getIndices())) {
          throw new Error(`The authored ${name} ${label} triangles differ from the native fit`)
        }
        revision = authoredPart.getMaterial()
      }
      if (!wholeStage) {
        revision = revisedRoot
          .listMaterials()
          .find((m) => m.getName() === `${label} ${material.getName()}`)
      }
      if (!revision) {
        continue
      }
      const uv = part.getAttribute('TEXCOORD_0')
      const values = uv?.getArray()
      if (!(uv && values instanceof Float32Array)) {
        throw new Error(`Missing ${name} ${label} float UVs`)
      }
      orphanedStreams.add(uv)
      const ground = label.startsWith('ground-')
      part.setAttribute(
        'TEXCOORD_0',
        uv.clone().setArray(values.map((v, i) => (ground || i % 2 === 0 ? v / 4 : v))),
      )
      const compressed = copyToDocument(native, authored, [revision]).get(revision)
      if (
        !(compressed instanceof Material) ||
        textures(compressed).some((texture) => texture.getMimeType() !== 'image/ktx2')
      ) {
        throw new Error(`Missing ${name} ${label} compressed material maps`)
      }
      if (name === 'duel') {
        orphanedMaterials.add(material)
        part.setMaterial(compressed)
      } else {
        const [color, normal, roughness, occlusion] = maps(compressed)
        material
          .setBaseColorTexture(color)
          .setNormalTexture(normal)
          .setMetallicRoughnessTexture(roughness)
          .setOcclusionTexture(occlusion)
        compressed.dispose()
      }
      replaced++
    }
  }
  if (replaced !== (name === 'duel' || name === 'bank' ? 2 : 1)) {
    throw new Error(`Unexpected ${name} material count: ${replaced}`)
  }
  for (const asset of [...orphanedMaterials, ...orphanedTextures, ...orphanedStreams]) {
    if (asset.listParents().every((parent) => parent === root)) {
      asset.dispose()
    }
  }
  const target = join(output, filename)
  await io.write(target, native)
  if (!isDeepStrictEqual(snapshot(await io.read(target), owned), baseline)) {
    throw new Error(`The ${name} overlay changed geometry, layout or unowned materials`)
  }
  const file = Bun.file(target)
  console.log(
    JSON.stringify({
      name,
      nodes: root.listNodes().length,
      replaced,
      bytes: file.size,
      sha256: digest(await file.bytes()),
    }),
  )
}
