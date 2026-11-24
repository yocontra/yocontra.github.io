/** Print the shipped model inventory, including meshes inside the combined town and arena files. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AMBIENT_ASSETS } from '../../src/experiments/out-west/content/ambient.ts'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { ASSETS, DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { outfitArms } from '../../src/experiments/out-west/content/outfit-arms.ts'
import type { ContentAsset } from '../../src/experiments/out-west/content/types.ts'

const inventory = new Map<string, { asset: ContentAsset; bindings: string[] }>()

function collect(value: unknown, binding: string) {
  if (!value || typeof value !== 'object') {
    return
  }
  if ('url' in value && typeof value.url === 'string' && value.url.includes('.glb')) {
    const asset = value as ContentAsset
    const path = asset.url.split('?')[0]
    if (!path) {
      throw new Error(`Empty URL for ${binding}`)
    }
    const entry = inventory.get(path) ?? { asset, bindings: [] }
    if (asset.hash !== entry.asset.hash) {
      throw new Error(`Conflicting hashes for ${path}`)
    }
    entry.bindings.push(binding)
    inventory.set(path, entry)
  }
  for (const [key, child] of Object.entries(value)) {
    collect(child, `${binding}.${key}`)
  }
}

interface Model {
  nodes?: { name?: string; mesh?: number }[]
  meshes?: { name?: string; primitives: { material?: number }[] }[]
  materials?: { name?: string }[]
}

// Paired actors, extracted arms and scene kits each have a second authoring input.
function modelSources(path: string, stem: string): string[] {
  const source = 'tools/art'
  if (path.includes('/fitted/')) {
    const artist = stem === 'outlaw-0' ? 'greenhorn' : 'trail-rider'
    return [
      `${source}/characters/${artist}/${artist}.blend`,
      'tools/content/trail-rider-preview.ts',
    ]
  }
  if (path.includes('/3d/dynamic/')) {
    return [join('public', path)]
  }
  const special: Record<string, string[]> = {
    'frontier-yard-high': [
      `${source}/environments/cactus-near/near-source.blend`,
      'tools/content/frontier-yard-high.ts',
    ],
    'barrel-fragments': [`${source}/environments/barrel-parts.glb`, 'tools/content/barrels.ts'],
    'viewmodel-arm-curves': ['tools/content/viewmodel-longguns-authoring.py'],
  }
  if (path.endsWith('/dynamic/crow.glb')) {
    return [`${source}/props/crow-cue.glb`]
  }
  if (special[stem]) {
    return special[stem]
  }
  const candidates = [
    `${source}/characters/${stem}.gltf`,
    `${source}/environments/${stem}.glb`,
    `${source}/props/${stem}.glb`,
    `${source}/props/cash/${stem}.glb`,
    `${source}/props/pickups/${stem}.glb`,
  ].filter(existsSync)
  if (candidates.length === 0 && stem.endsWith('.pair')) {
    candidates.push(
      `${source}/characters/${stem.slice(0, -5)}.gltf`,
      'tools/content/paired-grip-assets.ts',
    )
  }
  if (path.includes('/viewmodels/')) {
    candidates.push(join('public', path.replace('/viewmodels/', '/equipment/')))
    candidates.push('tools/content/first-person-arms.ts')
  }
  if (stem === 'player' || stem === 'outlaw-0' || stem.startsWith('outfit.')) {
    candidates.push('tools/content/saloon-cast-authoring.py', 'tools/content/saloon-cast.ts')
  }
  if (stem.startsWith('gun.')) {
    const exterior = stem === 'gun.buntline' ? 'long' : 'standard'
    candidates.push(
      `${source}/characters/revolver-exteriors/${exterior}.glb`,
      'tools/content/fitted-revolver.ts',
    )
  }
  if (stem === 'gun.rusty-six') {
    candidates.push('tools/content/rusty-six-finish-authoring.py')
  }
  if (stem === 'frontier') {
    candidates.push(
      `${source}/environments/frontier-saloon.glb`,
      'tools/content/frontier-saloon-authoring.py',
      'tools/content/frontier-authoring.ts',
    )
  }
  if (stem === 'horse' || stem === 'dog') {
    candidates.push(`${source}/characters/${stem}-parts.glb`, 'tools/content/animal-authoring.py')
  }
  if (candidates.length === 0 || !candidates.every(existsSync)) {
    throw new Error(`Missing model source for ${path}`)
  }
  return candidates
}

async function readModel(path: string, asset: ContentAsset, bindings: string[]) {
  const bytes = await readFile(join('public', path))
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== asset.hash || bytes.length !== asset.bytes) {
    throw new Error(`Stale manifest for ${path}`)
  }
  const model: Model = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)))
  const stem = basename(path, '.glb')
  const sources = modelSources(path, stem)
  const instances = new Map<number, string[]>()
  for (const [index, node] of (model.nodes ?? []).entries()) {
    if (node.mesh === undefined) {
      continue
    }
    const placements = instances.get(node.mesh) ?? []
    placements.push(node.name ?? `node-${index}`)
    instances.set(node.mesh, placements)
  }
  const meshes = (model.meshes ?? []).map((mesh, index) => ({
    name: mesh.name ?? `mesh-${index}`,
    placements: instances.get(index) ?? [],
    materials: [
      ...new Set(
        mesh.primitives.map(({ material }) =>
          material === undefined
            ? 'default'
            : (model.materials?.[material]?.name ?? String(material)),
        ),
      ),
    ],
  }))
  return {
    path,
    family: basename(dirname(path)),
    bindings,
    hash,
    bytes: bytes.length,
    sourceCandidates: sources,
    meshes,
  }
}

collect({ ASSETS, AMBIENT_ASSETS, DYNAMIC_ASSETS, EQUIPMENT, VIEWMODELS: outfitArms }, 'content')
const rows: Awaited<ReturnType<typeof readModel>>[] = []
for (const [path, entry] of [...inventory].sort(([a], [b]) => a.localeCompare(b))) {
  rows.push(await readModel(path, entry.asset, entry.bindings))
}
console.log(JSON.stringify(rows, null, 2))
