/** Rebuild native environments from the preserved, fully dressed authoring GLBs. */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, dequantize, prune, weld } from '@gltf-transform/functions'
import { compressedCharacterTexture } from './character-textures.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'
import { formatContent } from './format-content.ts'
import { packFrontierVertices } from './frontier-vertex-packing.ts'
import { optimizeAsset } from './optimize.ts'
import { dressStreetLamps, lampLights } from './street-lamps.ts'

const argument = (name: string, fallback: string) =>
  process.argv[process.argv.indexOf(name) + 1] ?? fallback
const source = process.argv.includes('--source')
  ? argument('--source', 'tools/art/environments')
  : 'tools/art/environments'
const output = process.argv.includes('--output')
  ? argument('--output', 'public/experiments/out-west/3d/native-v2/baked')
  : 'public/experiments/out-west/3d/native-v2/baked'
const names = ['frontier', 'duel', 'depot', 'mission', 'bank'] as const
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex < 0 ? undefined : process.argv[onlyIndex + 1]
if (only && !names.some((name) => name === only)) {
  throw new Error(`Unknown environment ${only}`)
}
const preserveTextures = process.argv.includes('--preserve-textures')

await mkdir(output, { recursive: true })
for (const name of names.filter((candidate) => !only || candidate === only)) {
  const path = join(output, `${name}.glb`)
  await copyFile(join(source, `${name}.glb`), path)
  if (name === 'frontier') {
    const authored = await io.read(path)
    // Full-detail props are present. Old far stand-ins required a shader fold mask to avoid duplication.
    for (const node of authored.getRoot().listNodes()) {
      if (node.getName().startsWith('far-')) {
        node.dispose()
      }
    }
    await io.write(path, authored)
  }
  if (name === 'duel') {
    const authored = await io.read(path)
    const image = authored
      .createTexture('Wanted poster')
      .setImage(await readFile(join(source, 'wanted-default.png')))
      .setMimeType('image/png')
    for (const material of authored.getRoot().listMaterials()) {
      if (material.getName() === 'WantedPaper') {
        material
          .setBaseColorTexture(image)
          .setEmissiveTexture(null)
          .setEmissiveFactor([0, 0, 0])
          .setExtension('KHR_materials_emissive_strength', null)
      }
    }
    await io.write(path, authored)
  }
  if (name === 'bank') {
    const authored = await io.read(path)
    const placements = await dressStreetLamps(authored, join(source, 'street-lamp.glb'))
    await io.write(path, authored)
    console.log('bank lamp lights', JSON.stringify(lampLights(placements)))
  }
  // Atlas selection was an old shader concern. Native materials carry ordinary tiled UVs.
  const flatten = Bun.spawn(['bun', 'tools/content/flatten-civic.ts', path], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await flatten.exited) !== 0) {
    throw new Error(`Could not flatten ${name} masonry`)
  }
  if (name === 'frontier' || preserveTextures) {
    const geometry = await io.read(path)
    await geometry.transform(dedup(), weld(), prune(), dequantize())
    await io.write(path, geometry)
  } else {
    await optimizeAsset(path)
  }
  const document = await io.read(path)
  // Native static batching transforms vertex data on the CPU: author float position/normal streams.
  await document.transform(dequantize())
  // A second native UV channel keeps moving cloud shade continuous across separate buildings.
  for (const node of document.getRoot().listNodes()) {
    const original = node.getMesh()
    if (original && name === 'frontier') {
      const unique = document.createMesh(original.getName()).setWeights(original.getWeights())
      for (const primitive of original.listPrimitives()) {
        unique.addPrimitive(primitive.clone())
      }
      node.setMesh(unique)
    }
    const matrix = node.getWorldMatrix()
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION')
      if (!position) {
        continue
      }
      const values = new Float32Array(position.getCount() * 2)
      for (let i = 0; i < position.getCount(); i++) {
        const [x = 0, y = 0, z = 0] = position.getElement(i, [])
        const wx =
          (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0)
        const wz =
          (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0)
        const ground = name === 'duel' && node.getName().startsWith('ground-')
        values[i * 2] = ground ? (wx + 16) / 32 : wx / 1024
        values[i * 2 + 1] = ground ? (wz + 70) / 128 : wz / 1024
      }
      primitive.setAttribute(
        'TEXCOORD_1',
        document.createAccessor().setType('VEC2').setArray(values).setBuffer(position.getBuffer()),
      )
    }
  }
  await io.write(path, document)
  const root = document.getRoot()
  if (name === 'frontier') {
    root.setExtras({
      ...root.getExtras(),
      frontierSourceHash: createHash('sha256')
        .update(await readFile(join(source, 'frontier.glb')))
        .digest('hex'),
    })
    root.listScenes()[0]?.listChildren()[0]?.setName('town')
    await io.write(path, document)
    const panes = Bun.spawn(
      ['bun', 'tools/content/window-panes.ts', path, 'tools/art/environments/frontier.plan.json'],
      {
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
    if ((await panes.exited) !== 0) {
      throw new Error('Could not author independently breakable windows')
    }
  }
  const foliage = root.listNodes().filter((node) => node.getName().startsWith('flora-'))
  if (name === 'frontier' && foliage.length === 0) {
    throw new Error('The complete Perdition vegetation pass is missing')
  }
  console.log(
    `${name}: ${root.listMeshes().length} meshes, ${root.listTextures().length} PBR textures, ${foliage.length} foliage chunks`,
  )
  if (name === 'frontier') {
    const packed = await io.read(path)
    console.log('Frontier vertex packing', await packFrontierVertices(packed))
    await io.write(path, packed)
  }
  await compressEnvironmentTextures(path)
}
if (only) {
  if (only === 'frontier' && output === 'public/experiments/out-west/3d/native-v2/baked') {
    const path = 'public/experiments/out-west/3d/native-v2/ambient/frontier-tumbleweeds.glb'
    await mkdir('public/experiments/out-west/3d/native-v2/ambient', { recursive: true })
    await copyFile(join(source, 'frontier-tumbleweeds.glb'), path)
    await optimizeAsset(path)
    const bytes = await readFile(path)
    console.log(
      JSON.stringify({
        ambient: 'frontier-tumbleweeds',
        url: path.slice(6),
        bytes: bytes.length,
        hash: createHash('sha256').update(bytes).digest('hex'),
      }),
    )
  }
  process.exit(0)
}
await writeFile(
  'src/experiments/out-west/content/lighting.json',
  await readFile(join(source, 'lighting.json')),
)
for (const name of ['duel', 'depot', 'mission', 'bank'] as const) {
  const configuration = JSON.parse(await readFile(join(source, `${name}.json`), 'utf8')) as {
    life: unknown
  }
  if (name === 'duel') {
    await writeFile(
      'src/experiments/out-west/content/street-life.json',
      `${JSON.stringify(configuration.life, null, 2)}\n`,
    )
  }
}
const skies: Record<string, { url: string; day: number }> = {}
await mkdir('public/experiments/out-west/3d/env', { recursive: true })
for (const [name, day] of [
  ['noon', 0],
  ['afternoon', 0.25],
  ['golden', 0.45],
  ['sunset', 0.6],
  ['dusk', 0.75],
  ['night', 1],
] as const) {
  const file = `sky-${name}.hdr`
  const bytes = await readFile(join(source, file))
  const hash = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join('public/experiments/out-west/3d/env', file), bytes)
  skies[name] = { url: `/experiments/out-west/3d/env/${file}?v=${hash.slice(0, 16)}`, day }
}
await writeFile(
  'src/experiments/out-west/content/skies.ts',
  `// Authored skies recovered from the original campaign; generated by tools/content/environment.ts.\nexport const SKIES = ${JSON.stringify(skies, null, 2)} as const\n`,
)
const ambient: Record<string, { url: string; bytes: number; hash: string }> = {}
await mkdir('public/experiments/out-west/3d/ambient', { recursive: true })
for (const name of [
  'crow',
  'hen',
  'shingles',
  'clockwork',
  'frontier-tumbleweeds',
  'duel-tumbleweeds',
] as const) {
  const directory = name === 'shingles' ? 'ambient' : 'native-v2/ambient'
  await mkdir(`public/experiments/out-west/3d/${directory}`, { recursive: true })
  const path = `public/experiments/out-west/3d/${directory}/${name}.glb`
  await copyFile(join(source, `${name}.glb`), path)
  await optimizeAsset(path)
  const bytes = await readFile(path)
  const hash = createHash('sha256').update(bytes).digest('hex')
  ambient[name] = {
    url: `/experiments/out-west/3d/${directory}/${name}.glb?v=${hash.slice(0, 16)}`,
    bytes: bytes.length,
    hash,
  }
}
for (const name of ['dust', 'cloud-shadow', 'ground-detail']) {
  const bytes = await readFile(join(source, `${name}.png`))
  const url =
    name === 'dust'
      ? `/experiments/out-west/3d/ambient/${name}.png`
      : await compressedCharacterTexture(bytes, true, 'environments')
  if (name === 'dust') {
    await writeFile(`public${url}`, bytes)
  }
  const encoded = name === 'dust' ? bytes : await readFile(`public${url}`)
  const hash = createHash('sha256').update(encoded).digest('hex')
  ambient[name] = {
    url: `${url}?v=${hash.slice(0, 16)}`,
    bytes: encoded.length,
    hash,
  }
}
await writeFile(
  'src/experiments/out-west/content/ambient.ts',
  `// Authored native ambient animation; generated by tools/content/environment.ts.\nexport const AMBIENT_ASSETS = ${JSON.stringify(ambient, null, 2)} as const\n`,
)
await formatContent([
  'src/experiments/out-west/content/ambient.ts',
  'src/experiments/out-west/content/skies.ts',
  'src/experiments/out-west/content/lighting.json',
  'src/experiments/out-west/content/street-life.json',
])
