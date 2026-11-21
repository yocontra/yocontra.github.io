/** Fit Blender furniture to Frontier cover sites and reuse the existing town scans. */
import { type Document, Material, Node } from '@gltf-transform/core'
import { copyToDocument, mergeDocuments } from '@gltf-transform/functions'
import type { Cover, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { type FrontierGeometry, frontierIO } from './frontier-geometry.ts'

const fabric = /baize|linen|wool/u

const dimensions = {
  'saloon-card-table': [1.5, 0.8, 1.5],
  'scrubbed-work-table': [2, 0.8, 1],
  'potbelly-stove': [1, 1.1, 1],
  'riveted-cash-safe': [1.5, 1.5, 1],
  'first-frontier-counter': [1.8, 1.1, 0.6],
  'linen-hotel-bed': [2, 0.6, 2],
  'mortised-plank-bench': [2.5, 0.5, 0.5],
  'stave-horse-trough': [2.5, 0.7, 1],
  'board-and-batten-freight-car': [12, 3.8, 3],
  'mercantile-display-counter': [3, 1.1, 0.6],
  'frontier-transaction-desk': [2.4, 1.1, 0.6],
  'chapel-communion-table': [1.8, 1.1, 1],
  'mortised-shop-workbench': [2, 0.95, 1],
  'square-cut-smithy-hearth': [2.5, 1, 2.5],
} as const

function roomAt(x: number, z: number, buildings: TownLayout['buildings']) {
  return buildings.find(
    ({ x: left, z: top, w, d }) => x > left && x < left + w && z > top && z < top + d,
  )
}

function furnitureName(
  cover: Cover,
  buildings: TownLayout['buildings'],
): keyof typeof dimensions | undefined {
  if (cover.kind === 'trough') {
    return 'stave-horse-trough'
  }
  if (cover.kind === 'boxcar') {
    return 'board-and-batten-freight-car'
  }
  if (cover.kind === 'bed') {
    return 'linen-hotel-bed'
  }
  if (cover.kind === 'bench') {
    return 'mortised-plank-bench'
  }
  if (cover.kind === 'stove') {
    return 'potbelly-stove'
  }
  if (cover.kind === 'safe') {
    return 'riveted-cash-safe'
  }
  if (cover.kind === 'workbench') {
    return 'mortised-shop-workbench'
  }
  if (cover.kind === 'forge') {
    return 'square-cut-smithy-hearth'
  }
  if (cover.kind === 'counter') {
    const kind = roomAt(cover.x + cover.w / 2, cover.z + cover.d / 2, buildings)?.kind
    switch (kind) {
      case 'bank':
        return 'first-frontier-counter'
      case 'church':
        return 'chapel-communion-table'
      case 'general_store':
        return 'mercantile-display-counter'
      case 'saloon':
      case undefined:
        return undefined
      default:
        return 'frontier-transaction-desk'
    }
  }
  if (cover.kind === 'table') {
    const inSaloon = cover.x >= 23 && cover.x < 42 && cover.z >= 32 && cover.z < 44
    return inSaloon && !cover.y0 ? 'saloon-card-table' : 'scrubbed-work-table'
  }
  return undefined
}

export function hasFittedFurniture(cover: Cover, buildings: TownLayout['buildings']): boolean {
  return furnitureName(cover, buildings) !== undefined
}

function scannedMaterial(name: string): string | undefined {
  if (name.includes('sandstone')) {
    return 'masonry'
  }
  if (name.includes('walnut') || name.includes('oak')) {
    return 'floor'
  }
  if (name.includes('iron')) {
    return 'iron'
  }
  return fabric.test(name) ? 'cloth' : undefined
}

function stoveFacing(x: number, z: number, buildings: TownLayout['buildings']): number {
  const room = roomAt(x, z, buildings)
  if (!room) {
    return 0
  }
  const dx = room.x + room.w / 2 - x
  const dz = room.z + room.d / 2 - z
  if (Math.abs(dx) > Math.abs(dz)) {
    return (Math.sign(dx) * Math.PI) / 2
  }
  return dz < 0 ? Math.PI : 0
}

function furnitureFacing(
  name: keyof typeof dimensions,
  x: number,
  z: number,
  buildings: TownLayout['buildings'],
): number {
  if (name === 'potbelly-stove') {
    return stoveFacing(x, z, buildings)
  }
  const room = roomAt(x, z, buildings)
  if (!room) {
    return 0
  }
  const centerZ = room.z + room.d / 2
  const north = centerZ < z
  if (name === 'riveted-cash-safe') {
    return centerZ > z ? Math.PI : 0
  }
  return (name === 'frontier-transaction-desk' || name === 'mortised-shop-workbench') && north
    ? Math.PI
    : 0
}

function furniturePlacement(
  doc: Document,
  fixture: Cover,
  buildings: TownLayout['buildings'],
  { name, index }: { name: keyof typeof dimensions; index: number },
): Node {
  const [width, height, depth] = dimensions[name]
  const bottom = fixture.y0 ?? 0
  const x = fixture.x + fixture.w / 2
  const z = fixture.z + fixture.d / 2
  const turned =
    (name === 'linen-hotel-bed' && fixture.w > fixture.d) ||
    (['mortised-plank-bench', 'stave-horse-trough', 'board-and-batten-freight-car'].includes(
      name,
    ) &&
      fixture.d > fixture.w)
  const orientation = turned ? Math.PI / 2 : furnitureFacing(name, x, z, buildings)
  const [siteWidth, siteDepth] = turned ? [fixture.d, fixture.w] : [fixture.w, fixture.d]
  return doc
    .createNode(`frontier-furniture:${name}:${index}`)
    .setTranslation([x, bottom, z])
    .setRotation([0, Math.sin(orientation / 2), 0, Math.cos(orientation / 2)])
    .setScale([siteWidth / width, ((fixture.top ?? 1) - bottom) / height, siteDepth / depth])
}

export async function installFrontierFurniture(
  geometry: FrontierGeometry,
  layout: TownLayout,
  paths: readonly string[],
): Promise<void> {
  const [art, ...additions] = await Promise.all(paths.map((path) => frontierIO.read(path)))
  if (!art) {
    throw new Error('Missing canonical Frontier furniture source')
  }
  for (const addition of additions) {
    mergeDocuments(art, addition)
  }
  const models = art
    .getRoot()
    .listScenes()
    .flatMap((scene) => scene.listChildren())
  const parts = models.flatMap((model) => model.listChildren())
  const copied = copyToDocument(geometry.doc, art, parts)
  for (const material of art.getRoot().listMaterials()) {
    const role = scannedMaterial(material.getName())
    if (!role) {
      continue
    }
    const scan = geometry.materials.get(role)
    const surface = copied.get(material)
    if (!(scan && surface instanceof Material && scan.getBaseColorTexture())) {
      throw new Error(`Missing Frontier scan ${role} for ${material.getName()}`)
    }
    surface
      .setBaseColorTexture(
        material.getName().includes('blackened') ? null : scan.getBaseColorTexture(),
      )
      .setNormalTexture(scan.getNormalTexture())
      .setNormalScale(0.48)
      .setOcclusionTexture(scan.getOcclusionTexture())
  }

  const root = geometry.group('Perdition fitted period furniture')
  for (const [index, fixture] of layout.cover.entries()) {
    const name = furnitureName(fixture, layout.buildings)
    if (!name) {
      continue
    }
    const template = models.find((model) => model.getName() === name)
    if (!template?.listChildren().length) {
      throw new Error(`Missing authored Frontier furniture ${name}`)
    }
    const placement = furniturePlacement(geometry.doc, fixture, layout.buildings, { name, index })
    for (const part of template.listChildren()) {
      const packed = copied.get(part)
      if (!(packed instanceof Node && packed.getMesh() && packed.listChildren().length === 0)) {
        throw new Error(`Missing packed mesh for ${name}`)
      }
      placement.addChild(
        geometry.doc
          .createNode(packed.getName())
          .setMatrix(packed.getMatrix())
          .setMesh(packed.getMesh()),
      )
    }
    root.addChild(placement)
  }
  for (const part of parts) {
    copied.get(part)?.dispose()
  }
}
