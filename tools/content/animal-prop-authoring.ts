/** Repeatable native glTF authoring. Legacy public assets are read-only compatibility inputs. */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Document, getBounds, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  copyToDocument,
  dedup,
  dequantize,
  prune,
  unpartition,
  weld,
} from '@gltf-transform/functions'
import { MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'
import { externalize, projectedUv, surfaceMaterial } from './animal-prop-surfaces.ts'
import { bakeCharacter } from './character-materials.ts'
import { bakeFoldedCrow } from './crow-fold.ts'
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
      projectedUv(doc, p, 6)
    }
  }
}
/** Blender-authored bird parts (animal-authoring.py) swapped onto the meshes under each hinge. */
async function authoredBird(name: string): Promise<boolean> {
  const partsPath = `tools/art/environments/${name}-parts.glb`
  if (!(await Bun.file(partsPath).exists())) {
    return false
  }
  const doc = await io.read(`tools/art/environments/${name}.glb`)
  const parts = await io.read(partsPath)
  const parents = parts.getRoot().getExtras().parents as Record<string, string>
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const texture = async (role: string) =>
    doc
      .createTexture(`${name} ${role}`)
      .setImage(await readFile(`tools/art/environments/bird-textures/${name}-${role}.png`))
      .setMimeType('image/png')
  const arm = await texture('arm')
  const material = doc
    .createMaterial(`${name} plumage`)
    .setBaseColorTexture(await texture('albedo'))
    .setNormalTexture(await texture('normal'))
    .setMetallicRoughnessTexture(arm)
    .setOcclusionTexture(arm)
    .setRoughnessFactor(1)
    .setMetallicFactor(0)
  const copy = (accessor: import('@gltf-transform/core').Accessor | null) => {
    const array = accessor?.getArray()
    if (!(accessor && array)) {
      throw new Error(`Missing ${name} part data`)
    }
    return doc
      .createAccessor()
      .setType(accessor.getType())
      .setArray(array.slice())
      .setBuffer(buffer)
  }
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    const parent = doc
      .getRoot()
      .listNodes()
      .find((candidate) => candidate.listChildren().includes(node))
    const partName = parent ? parents[parent.getName()] : undefined
    const source = parts
      .getRoot()
      .listMeshes()
      .find((m) => m.getName() === partName)
      ?.listPrimitives()[0]
    if (!(mesh && source)) {
      continue
    }
    for (const primitive of mesh.listPrimitives()) {
      mesh.removePrimitive(primitive)
      primitive.dispose()
    }
    const primitive = doc
      .createPrimitive()
      .setMaterial(material)
      .setIndices(copy(source.getIndices()))
    for (const semantic of source.listSemantics()) {
      primitive.setAttribute(semantic, copy(source.getAttribute(semantic)))
    }
    const count = source.getAttribute('POSITION')?.getCount() ?? 0
    // Native materials always multiply albedo by COLOR_0; the baked atlas carries every colour.
    primitive.setAttribute(
      'COLOR_0',
      doc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array(count * 3).fill(1))
        .setBuffer(buffer),
    )
    mesh.addPrimitive(primitive)
  }
  await doc.transform(
    dedup(),
    prune({ keepLeaves: true, keepAttributes: true }),
    unpartition(),
    dequantize(),
  )
  const output = `${native}/ambient/${name}.glb`
  await externalize(doc)
  if (name === 'crow') {
    const staging = await mkdtemp(join(tmpdir(), 'out-west-crow-base-'))
    try {
      const source = join(staging, 'crow.glb')
      await io.write(source, doc)
      await normalizeSkinnedAsset(source)
      await bakeFoldedCrow(source, output)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } else {
    await io.write(output, doc)
    await normalizeSkinnedAsset(output)
  }
  console.log(`authored ${output} from Blender parts`)
  return true
}
async function ambientAnimals() {
  for (const name of ['crow', 'hen']) {
    if (!(await authoredBird(name))) {
      throw new Error(`Missing ${name} Blender parts; run tools/content/animal-authoring.py`)
    }
  }
  const source = 'tools/art/environments/clockwork.glb'
  const doc = await io.read(source)
  textureUnmapped(doc, 'clockwork', await surfaceMaterial(doc, 'iron', 'clockwork surface detail'))
  await exportNative(doc, source, `${native}/ambient/clockwork.glb`)
}
const fittedPropBounds = {
  dynamite: [0.2, 0.4, 0.2],
  strongbox: [1.1, 0.617, 0.652],
  bag0: [0.4945, 0.349, 0.2616],
  bag1: [0.3771, 0.46, 0.3134],
  bag2: [0.3771, 0.46, 0.3134],
  bag3: [0.3771, 0.46, 0.3134],
} as const

async function fittedProp(name: keyof typeof fittedPropBounds) {
  const family = name === 'dynamite' ? 'pickups' : 'cash'
  const doc = await io.read(`tools/art/props/${family}/${name}.glb`)
  const scene = doc.getRoot().getDefaultScene()
  if (!scene) {
    throw new Error(`Missing authored ${name} scene`)
  }
  const oak =
    name === 'strongbox'
      ? await Promise.all(
          ['diff', 'nor', 'arm'].map(async (kind) =>
            doc
              .createTexture(`Strongbox oak ${kind}`)
              .setImage(await readFile(`public/experiments/out-west/3d/tex/planks_${kind}.webp`))
              .setMimeType('image/webp'),
          ),
        )
      : []
  for (const material of doc.getRoot().listMaterials()) {
    const label = material.getName()
    if (label.includes('oak')) {
      const [albedo, normal, arm] = oak
      if (!(albedo && normal && arm)) {
        throw new Error('Missing strongbox oak material')
      }
      material
        .setBaseColorTexture(albedo)
        .setNormalTexture(normal)
        .setMetallicRoughnessTexture(arm)
        .setOcclusionTexture(arm)
        .setNormalScale(0.55)
      continue
    }
    const kind = label.includes('iron') || label.includes('brass') ? 'iron' : 'canvas'
    const roughness = material.getRoughnessFactor()
    const metalness = material.getMetallicFactor()
    await surfaceMaterial(doc, kind, label)
    material.setRoughnessFactor(roughness).setMetallicFactor(metalness)
    if (name === 'dynamite' && label.includes('paper')) {
      material.setNormalScale(0.18)
    }
  }
  const [width, height, depth] = fittedPropBounds[name]
  const { min, max } = getBounds(scene)
  const scale = Math.min(
    width / (max[0] - min[0]),
    height / (max[1] - min[1]),
    depth / (max[2] - min[2]),
  )
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid authored ${name} bounds`)
  }
  const wrapper = doc
    .createNode(`detail.${name}`)
    .setScale([scale, scale, scale])
    .setTranslation([
      -((max[0] + min[0]) / 2) * scale,
      -min[1] * scale,
      -((max[2] + min[2]) / 2) * scale,
    ])
  for (const part of scene.listChildren()) {
    scene.removeChild(part)
    wrapper.addChild(part)
  }
  scene.addChild(wrapper)
  await exportNative(doc, `tools/art/props/${name}.glb`, `${native}/dynamic/${name}.glb`)
}
async function fitCoinSurface(doc: Document): Promise<void> {
  const art = await io.read('tools/art/props/pickups/coin.glb')
  const mesh = doc.getRoot().listMeshes()[0]
  const original = mesh?.listPrimitives()[0]
  const position = original?.getAttribute('POSITION')
  const part = art.getRoot().listMeshes()[0]?.listPrimitives()[0]
  if (!(mesh && original && position && part)) {
    throw new Error('Missing animated coin surface')
  }
  const replacement = copyToDocument(doc, art, [part]).get(part) as Primitive
  const points = replacement.getAttribute('POSITION')
  if (!points) {
    throw new Error('Missing milled coin geometry')
  }
  const from = { min: points.getMin([]), max: points.getMax([]) }
  const to = { min: position.getMin([]), max: position.getMax([]) }
  for (let i = 0; i < points.getCount(); i++) {
    points.setElement(
      i,
      points.getElement(i, []).map((value, axis) => {
        const lower = from.min[axis] ?? 0
        const sourceSpan = (from.max[axis] ?? 0) - lower
        const targetMin = to.min[axis] ?? 0
        const targetSpan = (to.max[axis] ?? 0) - targetMin
        return targetMin + ((value - lower) * targetSpan) / sourceSpan
      }),
    )
  }
  mesh.addPrimitive(replacement)
  original.dispose()
}
async function coin() {
  const doc = await io.read('public/experiments/out-west/3d/dynamic/coin.glb')
  await doc.transform(dequantize())
  await fitCoinSurface(doc)
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
if ((only === 'dog' || only === 'horse') && !(await authoredAnimal(only))) {
  throw new Error(`Missing ${only} Blender parts; run tools/content/animal-authoring.py`)
}
if (only === 'crow' && !(await authoredBird('crow'))) {
  throw new Error('Missing crow Blender parts; run tools/content/animal-authoring.py')
}
if (!only || only === 'animals') {
  await coatAnimals()
  await ambientAnimals()
}
if (!only || only === 'props' || only === 'cash') {
  for (const name of ['strongbox', 'bag0', 'bag1', 'bag2', 'bag3'] as const) {
    await fittedProp(name)
  }
}
if (!only || only === 'props' || only === 'pickups') {
  await fittedProp('dynamite')
  await coin()
}
if (!only || only === 'props') {
  await tumbleweed()
  await crowCue()
}
