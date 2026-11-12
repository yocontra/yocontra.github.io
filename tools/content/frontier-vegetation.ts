/** Desert vegetation surfaces: one scanned or baked material per plant tissue, shared wind morphs. */
import type { Document, Material, Mesh, Node, Primitive } from '@gltf-transform/core'
import { mergeDocuments, unpartition } from '@gltf-transform/functions'
import { scanMaterial } from './frontier-surfaces.ts'

type Tissue = 'cactus' | 'shrub' | 'wood' | 'rock' | 'replaced'
/** Texture tile edge in metres; saguaro skin carries four ribs per tile. */
const TILE: Record<Exclude<Tissue, 'replaced'>, number> = {
  cactus: 0.36,
  shrub: 0.5,
  wood: 0.9,
  rock: 1.4,
}
const SCAN: Record<Exclude<Tissue, 'replaced'>, [string, string]> = {
  cactus: ['Desert cactus skin', 'saguaro_skin'],
  shrub: ['Desert shrub leaves', 'sagebrush'],
  wood: ['Desert dead wood', 'bark_brown_02'],
  rock: ['Desert rock', 'rock_boulder_dry'],
}
/** Legacy prism saguaros this tall are replaced by authored ribbed saguaros. */
const TRUNK = 1.5
const ARM_REACH = 0.9

export interface Saguaro {
  x: number
  z: number
  top: number
  height: number
  spread: number
}
interface Island {
  vertices: number
  color: number[]
  min: number[]
  max: number[]
}
export interface FloraFrame {
  scale: number
  translation: readonly number[]
}

/** Connected components by shared vertices; plants are authored as separate islands. */
function islandRoots(primitive: Primitive): Int32Array {
  const count = primitive.getAttribute('POSITION')?.getCount() ?? 0
  const parent = new Int32Array(count).map((_, i) => i)
  const find = (a: number): number => {
    let root = a
    while (parent[root] !== root) {
      root = parent[root] ?? root
    }
    parent[a] = root
    return root
  }
  const indices = primitive.getIndices()
  for (let t = 0; indices && t < indices.getCount(); t += 3) {
    const a = find(indices.getScalar(t))
    parent[find(indices.getScalar(t + 1))] = a
    parent[find(indices.getScalar(t + 2))] = a
  }
  return parent.map((_, i) => find(i))
}

function islandStats(primitive: Primitive, roots: Int32Array, frame: FloraFrame) {
  const positions = primitive.getAttribute('POSITION')
  const colors = primitive.getAttribute('COLOR_0')
  const islands = new Map<number, Island>()
  for (const [vertex, root] of roots.entries()) {
    const p = (positions?.getElement(vertex, []) ?? []).map(
      (value, axis) => value * frame.scale + (frame.translation[axis] ?? 0),
    )
    const island = islands.get(root) ?? { vertices: 0, color: [0, 0, 0], min: [...p], max: [...p] }
    const color = colors?.getElement(vertex, []) ?? []
    island.color = island.color.map(
      (sum, channel) => (sum * island.vertices + (color[channel] ?? 0)) / (island.vertices + 1),
    )
    island.vertices++
    for (const axis of [0, 1, 2]) {
      island.min[axis] = Math.min(island.min[axis] ?? 0, p[axis] ?? 0)
      island.max[axis] = Math.max(island.max[axis] ?? 0, p[axis] ?? 0)
    }
    islands.set(root, island)
  }
  return islands
}

function tissueOf(island: Island): Exclude<Tissue, 'replaced'> {
  const [red = 0, green = 0, blue = 0] = island.color
  if (island.vertices < 9) {
    return 'shrub'
  }
  // Legacy palette: dark olive prisms are cactus, dark browns are trunks and deadfall, and
  // low-poly greys and tans are rocks.
  if (green > red && green < 0.16 && blue < 0.07) {
    return 'cactus'
  }
  if (red > green && green > 0.03 && red < 0.3) {
    return 'wood'
  }
  return blue >= 0.15 && island.vertices <= 20 ? 'rock' : 'shrub'
}

const centre = (island: Island, axis: number) =>
  ((island.min[axis] ?? 0) + (island.max[axis] ?? 0)) / 2

/** Classify islands; stacked prism saguaros (trunk segments and arms) become one placement. */
function classify(islands: Map<number, Island>, saguaros: Saguaro[]): Map<number, Tissue> {
  const tissue = new Map<number, Tissue>()
  const plants: Island[][] = []
  for (const [root, island] of islands) {
    const kind = tissueOf(island)
    tissue.set(root, kind)
    if (kind !== 'cactus') {
      continue
    }
    const near = (other: Island) =>
      Math.hypot(centre(island, 0) - centre(other, 0), centre(island, 2) - centre(other, 2)) <
      ARM_REACH
    const plant = plants.find((members) => members.some(near))
    if (plant) {
      plant.push(island)
    } else {
      plants.push([island])
    }
  }
  const replaced = new Set<Island>()
  for (const plant of plants) {
    const bottom = Math.min(...plant.map((island) => island.min[1] ?? 0))
    const top = Math.max(...plant.map((island) => island.max[1] ?? 0))
    // A real trunk: a solid prism, not a yucca flower stalk or a leaf fan.
    const trunk = plant.find(
      (island) =>
        island.vertices >= 16 &&
        (island.max[1] ?? 0) - (island.min[1] ?? 0) >= 1.2 &&
        (island.max[0] ?? 0) - (island.min[0] ?? 0) >= 0.2,
    )
    if (top - bottom < TRUNK || !trunk) {
      continue
    }
    const extent = (axis: number) =>
      Math.max(...plant.map((island) => island.max[axis] ?? 0)) -
      Math.min(...plant.map((island) => island.min[axis] ?? 0))
    saguaros.push({
      x: centre(trunk, 0),
      z: centre(trunk, 2),
      top,
      height: top - bottom,
      spread: Math.max(extent(0), extent(2)),
    })
    for (const island of plant) {
      replaced.add(island)
    }
  }
  for (const [root, island] of islands) {
    if (replaced.has(island)) {
      tissue.set(root, 'replaced')
    }
  }
  return tissue
}

/** Axis-dominant projection at a fixed world texel density, per tissue. */
function worldUv(primitive: Primitive, tile: (vertex: number) => number, scale: number) {
  const positions = primitive.getAttribute('POSITION')
  const normals = primitive.getAttribute('NORMAL')
  const uv = new Float32Array((positions?.getCount() ?? 0) * 2)
  for (let i = 0; positions && i < positions.getCount(); i++) {
    const p = positions.getElement(i, [])
    const [nx = 0, ny = 0, nz = 1] = normals?.getElement(i, []) ?? []
    const ax = Math.abs(nx)
    const az = Math.abs(nz)
    let axes = ax > az ? [2, 1] : [0, 1]
    if (Math.abs(ny) > Math.max(ax, az)) {
      axes = [0, 2]
    }
    const density = scale / tile(i)
    uv[i * 2] = (p[axes[0] ?? 0] ?? 0) * density
    uv[i * 2 + 1] = -(p[axes[1] ?? 1] ?? 0) * density
  }
  return uv
}

function splitPrimitive(
  { mesh, primitive }: { mesh: Mesh; primitive: Primitive },
  tissue: (vertex: number) => Tissue,
  materials: Map<Tissue, Material>,
  counts: Record<Tissue, number>,
) {
  const indices = primitive.getIndices()
  const positions = primitive.getAttribute('POSITION')
  if (!(indices && positions)) {
    return
  }
  const sets = new Map<Tissue, number[]>()
  for (let t = 0; t < indices.getCount(); t += 3) {
    const kind = tissue(indices.getScalar(t))
    const list = sets.get(kind) ?? []
    list.push(indices.getScalar(t), indices.getScalar(t + 1), indices.getScalar(t + 2))
    sets.set(kind, list)
    counts[kind] += 1
  }
  sets.delete('replaced')
  if (sets.size === 0) {
    primitive.dispose()
    return
  }
  const parts = [...sets].map(([kind, list], index) => {
    const part = index === 0 ? primitive : primitive.clone()
    if (index > 0) {
      // Compaction rewrites morph targets in place; each primitive needs its own.
      for (const morph of part.listTargets()) {
        part.removeTarget(morph).addTarget(morph.clone())
      }
      mesh.addPrimitive(part)
    }
    return { kind, list, part }
  })
  for (const { kind, list, part } of parts) {
    const array = positions.getCount() > 65_535 ? new Uint32Array(list) : new Uint16Array(list)
    part.setMaterial(materials.get(kind) ?? null).setIndices(indices.clone().setArray(array))
    if (kind === 'rock' || kind === 'cactus') {
      // Stone and succulent stems stay rigid; only leaves and twigs take the wind.
      for (const morph of part.listTargets()) {
        const delta = morph.getAttribute('POSITION')
        morph.setAttribute(
          'POSITION',
          delta?.clone().setArray(new Float32Array(delta.getCount() * 3)) ?? null,
        )
      }
    }
  }
}

export async function splitVegetation(doc: Document, frame: FloraFrame) {
  const flora = doc
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === 'flora')
  if (!flora) {
    throw new Error('Canonical library has no flora material')
  }
  const materials = new Map<Tissue, Material>()
  for (const [kind, [role, id]] of Object.entries(SCAN)) {
    const material = await scanMaterial(doc, role, id, { size: 512 })
    materials.set(kind as Tissue, material.setDoubleSided(flora.getDoubleSided()))
  }
  const counts: Record<Tissue, number> = { cactus: 0, shrub: 0, wood: 0, rock: 0, replaced: 0 }
  const saguaros: Saguaro[] = []
  const primitives = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives().map((primitive) => [mesh, primitive] as const))
    .filter(([, primitive]) => primitive.getMaterial() === flora)
  for (const [mesh, primitive] of primitives) {
    const positions = primitive.getAttribute('POSITION')
    if (!positions) {
      continue
    }
    const roots = islandRoots(primitive)
    const tissue = classify(islandStats(primitive, roots, frame), saguaros)
    const kindOf = (vertex: number) => tissue.get(roots[vertex] ?? 0) ?? 'shrub'
    const tile = (vertex: number) => {
      const kind = kindOf(vertex)
      return kind === 'replaced' ? 1 : TILE[kind]
    }
    primitive.setAttribute(
      'TEXCOORD_0',
      doc
        .createAccessor()
        .setType('VEC2')
        .setArray(worldUv(primitive, tile, frame.scale))
        .setBuffer(positions.getBuffer()),
    )
    splitPrimitive({ mesh, primitive }, kindOf, materials, counts)
  }
  flora.dispose()
  return { counts, saguaros }
}

/** Blender-authored saguaros and prickly pear, tinted by vertex colour over baked skin maps. */
export async function addCactusPrefabs(doc: Document, cacti: Document) {
  const skins: Record<string, [string, string]> = {
    'Saguaro skin': ['Perdition saguaro skin', 'saguaro_skin'],
    'Prickly pear pad': ['Perdition prickly pear', 'prickly_pear'],
  }
  mergeDocuments(doc, cacti)
  const prototypes = new Map<string, Node>()
  for (const material of doc.getRoot().listMaterials()) {
    const skin = skins[material.getName()]
    if (!skin) {
      continue
    }
    // Sun-faded olive rather than the authored vertex green.
    const scan = (await scanMaterial(doc, ...skin, { size: 512 })).setBaseColorFactor([
      0.95, 0.8, 0.9, 1,
    ])
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        if (primitive.getMaterial() === material) {
          primitive.setMaterial(scan)
        }
      }
    }
    material.dispose()
  }
  for (const scene of doc.getRoot().listScenes().slice(1)) {
    for (const node of scene.listChildren()) {
      prototypes.set(node.getName().slice(7), node)
      scene.removeChild(node)
    }
    scene.dispose()
  }
  await doc.transform(unpartition())
  return prototypes
}
