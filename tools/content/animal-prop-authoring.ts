/** Repeatable native glTF authoring. Legacy public assets are read-only compatibility inputs. */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Document, getBounds, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, dequantize, prune, unpartition, weld } from '@gltf-transform/functions'
import { MeshoptDecoder } from 'meshoptimizer'
import { SphereGeometry } from 'playcanvas'
import sharp from 'sharp'
import { externalize, kitMaterial, projectedUv, surfaceMaterial } from './animal-prop-surfaces.ts'
import { bakeCharacter } from './character-materials.ts'

import { normalizeSkinnedAsset } from './normalize-skinned-nodes.ts'

await MeshoptDecoder.ready
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
const native = 'public/experiments/out-west/3d/native-v2'
await Promise.all(
  ['tools/art/props/textures', `${native}/dynamic`, `${native}/ambient`].map((p) =>
    mkdir(p, { recursive: true }),
  ),
)
function decode(doc: Document) {
  doc
    .getRoot()
    .listExtensionsUsed()
    .find((e) => e.extensionName === 'EXT_meshopt_compression')
    ?.dispose()
}
async function exportNative(doc: Document, source: string, output: string) {
  await doc.transform(
    dedup(),
    weld(),
    prune({ keepLeaves: true, keepAttributes: true }),
    unpartition(),
    dequantize(),
  )
  await io.write(source, doc)
  await copyFile(source, output)
  await externalize(doc)
  await io.write(output, doc)
  await normalizeSkinnedAsset(output)
  console.log(`authored ${output}`)
}
function oval(
  doc: Document,
  mesh: import('@gltf-transform/core').Mesh,
  material: import('@gltf-transform/core').Material,
  { center, scale, color }: { center: number[]; scale: number[]; color: number[] },
) {
  const g = new SphereGeometry({ radius: 1, latitudeBands: 6, longitudeBands: 10 })
  if (!(g.positions && g.normals && g.uvs && g.indices)) {
    throw new Error('Missing sphere geometry')
  }
  const positions = g.positions.map((v, i) => v * (scale[i % 3] ?? 1) + (center[i % 3] ?? 0))
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const a = (type: 'VEC2' | 'VEC3', values: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer)
  const colors = Array.from({ length: positions.length / 3 }, () => color).flat()
  mesh.addPrimitive(
    doc
      .createPrimitive()
      .setMaterial(material)
      .setAttribute('POSITION', a('VEC3', positions))
      .setAttribute('NORMAL', a('VEC3', g.normals))
      .setAttribute('COLOR_0', a('VEC3', colors))
      .setAttribute('TEXCOORD_0', a('VEC2', g.uvs))
      .setIndices(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Uint16Array(g.indices))
          .setBuffer(buffer),
      ),
  )
}
function birdDetails(
  doc: Document,
  name: string,
  material: import('@gltf-transform/core').Material,
) {
  if (doc.getRoot().getExtras().birdDetails) {
    return
  }
  const meshes = doc.getRoot().listMeshes()
  const head = meshes[1]
  const body = meshes[0]
  if (!(head && body)) {
    return
  }
  for (const side of [-1, 1]) {
    oval(doc, head, material, {
      center: name === 'hen' ? [side * 0.05, 0.392, 0.109] : [side * 0.035, 0.16, 0.119],
      scale: name === 'hen' ? [0.007, 0.008, 0.009] : [0.0045, 0.005, 0.005],
      color: [0.004, 0.003, 0.002],
    })
    if (name === 'hen') {
      oval(doc, body, material, {
        center: [side * 0.077, 0.224, -0.012],
        scale: [0.025, 0.094, 0.08],
        color: [0.52, 0.4, 0.25],
      })
    }
  }
  if (name === 'hen') {
    for (let i = 0; i < 4; i++) {
      oval(doc, body, material, {
        center: [(i - 1.5) * 0.019, 0.3 + i * 0.008, -0.136],
        scale: [0.014, 0.068, 0.037],
        color: [0.19 + i * 0.04, 0.12 + i * 0.03, 0.055 + i * 0.02],
      })
    }
  }
  doc.getRoot().setExtras({ ...doc.getRoot().getExtras(), birdDetails: true })
}
/** Blender-authored body, tack and hair cards (animal-authoring.py) spliced onto the canonical rig. */
async function authoredAnimal(name: string): Promise<boolean> {
  const partsPath = `tools/art/characters/${name}-parts.glb`
  if (!(await Bun.file(partsPath).exists())) {
    return false
  }
  const doc = await io.read(`tools/art/characters/${name}.gltf`)
  const parts = await io.read(partsPath)
  const skinned = doc
    .getRoot()
    .listNodes()
    .find((node) => node.getMesh() && node.getSkin())
  const mesh = skinned?.getMesh()
  const joints = skinned?.getSkin()?.listJoints()
  if (!(mesh && joints)) {
    throw new Error(`Missing ${name} skinned body`)
  }
  const expected = parts.getRoot().getExtras().jointNames
  if (JSON.stringify(joints.map((joint) => joint.getName())) !== JSON.stringify(expected)) {
    throw new Error(`${name} parts were authored against a different skeleton`)
  }
  for (const primitive of mesh.listPrimitives()) {
    mesh.removePrimitive(primitive)
    primitive.dispose()
  }
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const texture = async (surface: string, role: string) =>
    doc
      .createTexture(`${name} ${surface} ${role}`)
      .setImage(
        await readFile(`tools/art/characters/animal-textures/${name}-${surface}-${role}.png`),
      )
      .setMimeType('image/png')
  for (const source of parts
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())) {
    const surface = String(source.getExtras().surface)
    const arm = await texture(surface, 'arm')
    const material = doc
      .createMaterial(`${name} ${surface}`)
      .setBaseColorTexture(await texture(surface, 'albedo'))
      .setNormalTexture(await texture(surface, 'normal'))
      .setMetallicRoughnessTexture(arm)
      .setOcclusionTexture(arm)
      .setRoughnessFactor(1)
      .setMetallicFactor(1)
    if (surface === 'hair') {
      material.setAlphaMode('MASK').setAlphaCutoff(0.42).setDoubleSided(true)
    }
    const primitive = doc.createPrimitive().setMaterial(material)
    for (const semantic of source.listSemantics()) {
      const attribute = source.getAttribute(semantic)
      const array = attribute?.getArray()
      if (!(attribute && array)) {
        throw new Error(`Missing ${name} ${semantic}`)
      }
      primitive.setAttribute(
        semantic,
        doc.createAccessor().setType(attribute.getType()).setArray(array.slice()).setBuffer(buffer),
      )
    }
    const count = source.getAttribute('POSITION')?.getCount() ?? 0
    // Native materials always multiply albedo by COLOR_0; authored maps carry every colour.
    primitive.setAttribute(
      'COLOR_0',
      doc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array(count * 3).fill(1))
        .setBuffer(buffer),
    )
    const indices = source.getIndices()?.getArray()
    if (!indices) {
      throw new Error(`Missing ${name} indices`)
    }
    primitive.setIndices(
      doc.createAccessor().setType('SCALAR').setArray(indices.slice()).setBuffer(buffer),
    )
    mesh.addPrimitive(primitive)
  }
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }))
  const staging = await mkdtemp(join(tmpdir(), `out-west-${name}-`))
  try {
    await io.write(join(staging, `${name}.gltf`), doc)
    await bakeCharacter(join(staging, `${name}.gltf`))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const output = `${native}/dynamic/${name}.glb`
  const baked = await io.read(output)
  await externalize(baked)
  await io.write(output, baked)
  await normalizeSkinnedAsset(output)
  console.log(`authored native ${name} from Blender parts`)
  return true
}
async function coatAnimals() {
  for (const name of ['dog', 'horse']) {
    if (!(await authoredAnimal(name))) {
      throw new Error(`Missing ${name} Blender parts; run tools/content/animal-authoring.py`)
    }
  }
}
function crowFeathers(doc: Document, surface: import('@gltf-transform/core').Material) {
  // Wing tips become a readable fan of feathers without changing any animation joint.
  if (!doc.getRoot().getExtras().featherFan) {
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh()
      const primitive = mesh?.listPrimitives()[0]
      const positions = primitive?.getAttribute('POSITION')
      if (!(mesh && primitive && positions && positions.getCount() === 12)) {
        continue
      }
      const max = positions.getMax([])
      const side = (max[0] ?? 0) > 0 ? 1 : -1
      const points: number[] = []
      const indices: number[] = []
      const uv: number[] = []
      const normals: number[] = []
      const colors: number[] = []
      for (let i = 0; i < 7; i++) {
        const x0 = side * (0.04 + i * 0.027)
        const x1 = side * (0.082 + i * 0.031)
        const z0 = 0.047 - i * 0.012
        const z1 = -0.052 - i * 0.013
        const offset = points.length / 3
        points.push(x0, 0.12, z0, x1, 0.12, z0 - 0.022, x1, 0.12, z1, x0, 0.12, z1 + 0.008)
        uv.push(0, 0, 1, 0, 1, 1, 0, 1)
        for (let j = 0; j < 4; j++) {
          normals.push(0, 1, 0)
          colors.push(0.019, 0.017, 0.025)
        }
        indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
      }
      const buffer = positions.getBuffer()
      const accessor = (type: 'VEC2' | 'VEC3', array: Float32Array<ArrayBuffer>) =>
        doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)
      const fan = doc
        .createPrimitive()
        .setAttribute('POSITION', accessor('VEC3', new Float32Array(points)))
        .setAttribute('NORMAL', accessor('VEC3', new Float32Array(normals)))
        .setAttribute('COLOR_0', accessor('VEC3', new Float32Array(colors)))
        .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(uv)))
        .setIndices(
          doc
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Uint16Array(indices))
            .setBuffer(buffer),
        )
        .setMaterial(surface.clone().setDoubleSided(true))
      mesh.removePrimitive(primitive)
      primitive.dispose()
      mesh.addPrimitive(fan)
    }
    doc.getRoot().setExtras({ ...doc.getRoot().getExtras(), featherFan: true })
  }
}
function textureUnmapped(
  doc: Document,
  name: string,
  surface: import('@gltf-transform/core').Material,
) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      if (p.getMaterial()?.getBaseColorTexture()) {
        continue
      }
      const original = p.getMaterial()
      const material = surface
        .clone()
        .setName(`${name} ${original?.getName() ?? 'surface'}`)
        .setBaseColorFactor(original?.getBaseColorFactor() ?? [1, 1, 1, 1])
      if (original) {
        material.setMetallicFactor(original.getMetallicFactor())
      }
      p.setMaterial(material)
      projectedUv(doc, p, name === 'clockwork' ? 6 : 3)
    }
  }
}
async function ambientAnimals() {
  for (const name of ['crow', 'hen', 'clockwork']) {
    const source = `tools/art/environments/${name}.glb`
    const doc = await io.read(source)
    const surface = await surfaceMaterial(
      doc,
      name === 'clockwork' ? 'iron' : 'feather',
      `${name} surface detail`,
    )
    textureUnmapped(doc, name, surface)
    if (name === 'crow') {
      crowFeathers(doc, surface)
    }
    if (name !== 'clockwork') {
      birdDetails(doc, name, surface)
    }
    await exportNative(doc, source, `${native}/ambient/${name}.glb`)
  }
}
async function kitProp(name: string, template: string) {
  const doc = await io.read('public/experiments/out-west/3d/models/props.glb')
  decode(doc)
  const selected = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === template)
  if (!selected) {
    throw new Error(`Missing Kit ${template}`)
  }
  const scene = doc.createScene(`Western ${name}`)
  scene.addChild(selected)
  for (const other of doc
    .getRoot()
    .listScenes()
    .filter((s) => s !== scene)) {
    other.dispose()
  }
  doc.getRoot().setDefaultScene(scene)
  await doc.transform(prune({ keepAttributes: true }), dequantize())
  const map = await kitMaterial(doc)
  if (name === 'bag2') {
    map.setBaseColorFactor([0.82, 0.9, 0.7, 1])
  }
  if (name === 'bag3') {
    map.setBaseColorFactor([0.76, 0.63, 0.46, 1])
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      p.setMaterial(map)
    }
  }
  const old = await io.read(`public/experiments/out-west/3d/dynamic/${name}.glb`)
  const oldScene = old.getRoot().listScenes()[0]
  if (!oldScene) {
    throw new Error('Missing legacy prop bounds')
  }
  const oldBounds = getBounds(oldScene)
  const bounds = getBounds(scene)
  const span = bounds.max.map((v, i) => v - (bounds.min[i] ?? 0))
  const target = oldBounds.max.map((v, i) => v - (oldBounds.min[i] ?? 0))
  const k = Math.min(...span.map((v, i) => (target[i] ?? 1) / Math.max(v, 0.0001)))
  const scale = [k, k, k]
  const wrapper = doc
    .createNode(`detail.${name}`)
    .setScale(scale as [number, number, number])
    .setTranslation(
      bounds.min.map((v, i) =>
        i === 1
          ? (oldBounds.min[i] ?? 0) - v * k
          : ((oldBounds.min[i] ?? 0) + (oldBounds.max[i] ?? 0)) / 2 -
            (((bounds.min[i] ?? 0) + (bounds.max[i] ?? 0)) / 2) * k,
      ) as [number, number, number],
    )
  scene.removeChild(selected)
  wrapper.addChild(selected)
  scene.addChild(wrapper)
  await exportNative(doc, `tools/art/props/${name}.glb`, `${native}/dynamic/${name}.glb`)
}
async function coin() {
  const doc = await io.read('public/experiments/out-west/3d/dynamic/coin.glb')
  await doc.transform(dequantize())
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#9d7132"/><circle cx="256" cy="256" r="241" fill="#d3a756" stroke="#624524" stroke-width="9"/><circle cx="256" cy="256" r="220" fill="none" stroke="#efd39a" stroke-width="6"/><circle cx="256" cy="256" r="191" fill="none" stroke="#8f632d" stroke-width="3"/><text x="256" y="139" text-anchor="middle" font-family="Georgia" font-size="48" font-weight="bold" fill="#584020">OUT WEST</text><text x="256" y="300" text-anchor="middle" font-family="Georgia" font-size="160" font-weight="bold" fill="#efcf89" stroke="#735023" stroke-width="4">20</text><text x="256" y="370" text-anchor="middle" font-family="Georgia" font-size="32" fill="#63451e">FRONTIER BANK</text><text x="256" y="414" text-anchor="middle" font-family="Georgia" font-size="25" fill="#f4d798">★ 1886 ★</text>${Array.from({ length: 64 }, (_, i) => `<circle cx="${256 + 229 * Math.cos((i * Math.PI) / 32)}" cy="${256 + 229 * Math.sin((i * Math.PI) / 32)}" r="3" fill="#513c22"/>`).join('')}</svg>`
  const image = await sharp(Buffer.from(svg)).png().toBuffer()
  await writeFile('tools/art/props/textures/minted-coin.png', image)
  const texture = doc
    .createTexture('Frontier bank stamped coin')
    .setImage(image)
    .setMimeType('image/png')
  const gold = await surfaceMaterial(doc, 'iron', 'Worn minted gold')
  gold.setBaseColorTexture(texture).setMetallicFactor(0.9).setRoughnessFactor(0.56)
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      p.setMaterial(gold)
      const positions = p.getAttribute('POSITION')
      if (!positions) {
        throw new Error('Missing minted coin positions')
      }
      const uv = new Float32Array(positions.getCount() * 2)
      const min = positions.getMin([])
      const max = positions.getMax([])
      for (let i = 0; i < positions.getCount(); i++) {
        const [x = 0, , z = 0] = positions.getElement(i, [])
        uv.set(
          [
            (x - (min[0] ?? 0)) / ((max[0] ?? 1) - (min[0] ?? 0)),
            (z - (min[2] ?? 0)) / ((max[2] ?? 1) - (min[2] ?? 0)),
          ],
          i * 2,
        )
      }
      p.setAttribute(
        'TEXCOORD_0',
        doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(positions.getBuffer()),
      )
    }
  }
  await exportNative(doc, 'tools/art/props/coin.glb', `${native}/dynamic/coin.glb`)
}
async function tumbleweed() {
  const doc = await io.read('public/experiments/out-west/3d/dynamic/tumbleweed.glb')
  await doc.transform(dequantize())
  const surface = await surfaceMaterial(doc, 'straw')
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const color = primitive.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1]
      primitive.setMaterial(surface.clone().setBaseColorFactor(color))
      projectedUv(doc, primitive, 6)
    }
  }
  await exportNative(doc, 'tools/art/props/tumbleweed.glb', `${native}/dynamic/tumbleweed.glb`)
}
async function crowCue() {
  const doc = await io.read('public/experiments/out-west/3d/dynamic/crow.glb')
  await doc.transform(dequantize())
  const surface = await surfaceMaterial(doc, 'feather')
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const color = primitive.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1]
      primitive.setMaterial(surface.clone().setBaseColorFactor(color))
      projectedUv(doc, primitive, 3)
    }
  }
  await exportNative(doc, 'tools/art/props/crow-cue.glb', `${native}/dynamic/crow.glb`)
}
const only = process.argv[2]
if (!only || only === 'animals') {
  await coatAnimals()
  await ambientAnimals()
}
if (!only || only === 'props') {
  for (const [name, template] of [
    ['strongbox', 'k_chest_kit'],
    ['bag0', 'k_pouch_kit'],
    ['bag1', 'k_sack_kit'],
    ['bag2', 'k_sack_kit'],
    ['bag3', 'k_sack_kit'],
    ['dynamite', 'dynamite_kit'],
  ] as const) {
    await kitProp(name, template)
  }
  await coin()
  await tumbleweed()
  await crowCue()
}
