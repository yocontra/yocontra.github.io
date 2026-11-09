/** Campaign art dressing, baked into ordinary glTF; duel and spectator lanes stay clear. */
import { writeFile } from 'node:fs/promises'
import { type Document, type Material, type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dequantize, mergeDocuments, prune, unpartition } from '@gltf-transform/functions'
import { MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'
import {
  externalize,
  kitMaterial,
  projectedUv,
  type Surface,
  surfaceMaterial,
} from './animal-prop-surfaces.ts'

await MeshoptDecoder.ready
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
type Arena = 'duel' | 'depot' | 'mission' | 'bank'
interface Dressing {
  template: string
  x: number
  y: number
  z: number
  yaw?: number
  scale?: number
}
const dressing: Record<Arena, Dressing[]> = {
  duel: [
    { template: 'k_bucket_kit', x: 10.55, y: 0.34, z: 9.4 },
    { template: 'k_sack_kit', x: 10.5, y: 0.34, z: 21.4, yaw: 0.2 },
    { template: 'k_rope_kit', x: 10.2, y: 0.35, z: 22.5 },
    { template: 'k_farmcrate_kit', x: -10.45, y: 0.34, z: 10.7, yaw: 1.57 },
    { template: 'k_bottle_kit', x: -10.45, y: 0.59, z: 10.7 },
    { template: 'k_bucket_metal_kit', x: -10.5, y: 0.34, z: 22.7 },
  ],
  depot: [
    { template: 'k_sack_kit', x: 12.3, y: 0.34, z: 7.5, yaw: 0.4 },
    { template: 'k_sack_kit', x: 12.2, y: 0.34, z: 8.2, yaw: -0.2 },
    { template: 'k_rope_kit', x: 12.4, y: 0.35, z: 9 },
    { template: 'k_crate_big_kit', x: 12.5, y: 0.34, z: 27.4 },
    { template: 'k_bucket_metal_kit', x: 12, y: 0.34, z: 28.4 },
    { template: 'k_farmcrate_kit', x: -10, y: 0, z: 21.3 },
  ],
  mission: [
    { template: 'k_bucket_kit', x: 10.4, y: 0, z: 16.4 },
    { template: 'k_sack_kit', x: -10, y: 0, z: 24.5 },
    { template: 'k_farmcrate_kit', x: -10.1, y: 0, z: 25.4 },
    { template: 'k_rope_kit', x: 10.3, y: 0.01, z: 26.4 },
    { template: 'k_bottle_kit', x: 10.4, y: 0, z: 27.3 },
  ],
  bank: [
    { template: 'k_chest_kit', x: 10.4, y: 0.34, z: 30.5, yaw: 1.57, scale: 0.75 },
    { template: 'k_sack_kit', x: 10.35, y: 0.34, z: 31.6 },
    { template: 'k_bucket_metal_kit', x: -10.5, y: 0.34, z: 17.1 },
    { template: 'k_farmcrate_kit', x: -10.5, y: 0.34, z: 18.1 },
  ],
}
const signs: Record<
  Arena,
  { text: string; x: number; y: number; z: number; w: number; h: number }[]
> = {
  duel: [
    { text: 'PERDITION SALOON', x: 10.96, y: 5.95, z: 2, w: 7, h: 0.86 },
    { text: 'MERCANTILE & SUPPLY', x: 10.96, y: 5.95, z: 15, w: 7, h: 0.86 },
    { text: 'GRAND HOTEL', x: 10.96, y: 5.95, z: 30, w: 7, h: 0.86 },
    { text: 'LIVERY & FEED', x: -10.96, y: 5.95, z: 5.5, w: 6, h: 0.86 },
    { text: 'ASSAY OFFICE', x: -10.96, y: 5.95, z: 18, w: 6, h: 0.86 },
    { text: 'UNDERTAKER', x: -10.96, y: 5.95, z: 30, w: 6, h: 0.86 },
  ],
  depot: [
    { text: 'OVERLAND FREIGHT', x: 13.19, y: 3.55, z: 4, w: 6, h: 0.65 },
    { text: 'TICKETS & TELEGRAPH', x: 13.19, y: 3.55, z: 21, w: 7, h: 0.65 },
  ],
  mission: [{ text: 'SAN MIGUEL • FOUNDED 1742', x: 10.9, y: 3.3, z: 23, w: 5, h: 0.6 }],
  bank: [],
}
function quad(
  doc: Document,
  root: Node,
  {
    name,
    material,
    points,
    uv,
    normal,
  }: { name: string; material: Material; points: number[]; uv: number[]; normal: number[] },
) {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const a = (type: 'VEC2' | 'VEC3', values: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer)
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', a('VEC3', points))
    .setAttribute('NORMAL', a('VEC3', [...normal, ...normal, ...normal, ...normal]))
    .setAttribute('TEXCOORD_0', a('VEC2', uv))
    .setIndices(
      doc
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
        .setBuffer(buffer),
    )
    .setMaterial(material)
  root.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(primitive)))
}
async function addSigns(doc: Document, root: Node, name: Arena) {
  const labels = signs[name]
  if (labels.length === 0) {
    return
  }
  const width = 2048
  const cell = 192
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${cell * labels.length}">${labels.map(({ text }, i) => `<g transform="translate(0 ${i * cell})"><rect width="2048" height="192" fill="#32271d"/><rect x="10" y="10" width="2028" height="172" fill="#b89a64" stroke="#e4cf9b" stroke-width="5"/><rect x="25" y="25" width="1998" height="142" fill="#453526" stroke="#80633c" stroke-width="4"/><text x="1024" y="128" text-anchor="middle" font-family="Georgia" font-weight="bold" font-size="100" letter-spacing="5" fill="#e5d3a5">${text.replaceAll('&', '&amp;')}</text><path d="M0 45H2048M0 151H2048" stroke="#382b20" stroke-width="2" stroke-opacity=".3"/></g>`).join('')}</svg>`
  const image = await sharp(Buffer.from(svg)).png().toBuffer()
  await writeFile(`tools/art/props/textures/${name}-shop-signs.png`, image)
  const material = doc
    .createMaterial('ambiance.weathered shop signs')
    .setBaseColorTexture(
      doc.createTexture(`${name} painted signs`).setImage(image).setMimeType('image/png'),
    )
    .setRoughnessFactor(0.96)
    .setDoubleSided(true)
  labels.forEach((s, i) => {
    const facing = s.x > 0 ? -1 : 1
    const z1 = s.z - (s.w / 2) * facing
    const z2 = s.z + (s.w / 2) * facing
    quad(doc, root, {
      name: `ambiance.sign.${i}`,
      material,
      points: [
        s.x,
        s.y - s.h / 2,
        z1,
        s.x,
        s.y - s.h / 2,
        z2,
        s.x,
        s.y + s.h / 2,
        z2,
        s.x,
        s.y + s.h / 2,
        z1,
      ],
      uv: [
        1,
        (i + 1) / labels.length,
        0,
        (i + 1) / labels.length,
        0,
        i / labels.length,
        1,
        i / labels.length,
      ],
      normal: [facing, 0, 0],
    })
  })
}
function cloneTree(doc: Document, source: Node): Node {
  const result = doc
    .createNode(source.getName())
    .setTranslation(source.getTranslation())
    .setRotation(source.getRotation())
    .setScale(source.getScale())
    .setMesh(source.getMesh())
  for (const child of source.listChildren()) {
    result.addChild(cloneTree(doc, child))
  }
  return result
}
async function addDressing(doc: Document, root: Node, name: Arena) {
  const kit = await io.read('public/experiments/out-west/3d/models/props.glb')
  kit
    .getRoot()
    .listExtensionsUsed()
    .find((e) => e.extensionName === 'EXT_meshopt_compression')
    ?.dispose()
  const wanted = new Set(dressing[name].map((p) => p.template))
  const scene = kit.createScene('Dressing library')
  for (const node of kit.getRoot().listNodes()) {
    if (wanted.has(node.getName())) {
      scene.addChild(node)
    }
  }
  for (const other of kit
    .getRoot()
    .listScenes()
    .filter((s) => s !== scene)) {
    other.dispose()
  }
  kit.getRoot().setDefaultScene(scene)
  await kit.transform(prune({ keepAttributes: true }), dequantize())
  const material = await kitMaterial(kit)
  for (const mesh of kit.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      p.setMaterial(material)
    }
  }
  const mapped = mergeDocuments(doc, kit)
  for (const [i, p] of dressing[name].entries()) {
    const original = kit
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === p.template)
    const prototype = original ? (mapped.get(original) as Node) : undefined
    if (!prototype) {
      throw new Error(`Missing dressing ${p.template}`)
    }
    const item = cloneTree(doc, prototype)
    const k = p.scale ?? 1
    const angle = p.yaw ?? 0
    const wrapper = doc
      .createNode(`ambiance.dressing.${i}`)
      .setTranslation([p.x, p.y, p.z])
      .setScale([k, k, k])
      .setRotation([0, Math.sin(angle / 2), 0, Math.cos(angle / 2)])
    wrapper.addChild(item)
    root.addChild(wrapper)
  }
  for (const extra of doc.getRoot().listScenes().slice(1)) {
    extra.dispose()
  }
}
for (const name of ['duel', 'depot', 'mission', 'bank'] as const) {
  const path = `tools/art/environments/${name}.glb`
  const doc = await io.read(path)
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]
  if (!scene) {
    throw new Error(`Missing ${name}`)
  }
  for (const node of [...doc.getRoot().listNodes()]) {
    if (node.getName().startsWith('ambiance.')) {
      node.dispose()
    }
  }
  const root = doc.createNode('ambiance.dressing')
  scene.addChild(root)
  const materials = new Map<string, Material>()
  for (const node of doc.getRoot().listNodes()) {
    for (const p of node.getMesh()?.listPrimitives() ?? []) {
      const old = p.getMaterial()
      if (
        !old ||
        old.getBaseColorTexture() ||
        old.getAlphaMode() === 'BLEND' ||
        old.getEmissiveFactor().some((v) => v > 0)
      ) {
        continue
      }
      let kind: Surface = 'iron'
      if (node.getName().startsWith('flora-')) {
        kind = 'cactus'
      } else if (node.getName().startsWith('hay-') || old.getName() === 'Hay') {
        kind = 'straw'
      } else if (old.getName() === 'flora') {
        kind = 'bark'
      } else if (old.getMetallicFactor() < 0.1) {
        kind = 'canvas'
      }
      const key = `${kind}/${old.getBaseColorFactor().join(',')}`
      let material = materials.get(key)
      if (!material) {
        material = (await surfaceMaterial(doc, kind))
          .clone()
          .setName(`ambiance.${kind}`)
          .setBaseColorFactor(old.getBaseColorFactor())
          .setMetallicFactor(old.getMetallicFactor())
        materials.set(key, material)
      }
      projectedUv(doc, p, kind === 'straw' ? 8 : 6)
      p.setMaterial(material)
    }
  }
  await addSigns(doc, root, name)
  await addDressing(doc, root, name)
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }), unpartition())
  await io.write(path, doc)
  console.log(
    `authored ${name}: ${dressing[name].length} service props / ${signs[name].length} painted identities`,
  )
}
// Author native wilds using the same straw response, retaining every morph/animation channel.
for (const name of ['duel-tumbleweeds']) {
  const path = `tools/art/environments/${name}.glb`
  const doc = await io.read(path)
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const old = p.getMaterial()
      const material = (await surfaceMaterial(doc, 'straw'))
        .clone()
        .setBaseColorFactor(old?.getBaseColorFactor() ?? [1, 1, 1, 1])
      projectedUv(doc, p, 8)
      p.setMaterial(material)
    }
  }
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }), unpartition())
  await io.write(path, doc)
  const output = `public/experiments/out-west/3d/native-v2/ambient/${name}.glb`
  await externalize(doc)
  await io.write(output, doc)
}
