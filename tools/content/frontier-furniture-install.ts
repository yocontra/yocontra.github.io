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
  'wall-stock-shelves': [4, 2.3, 0.5],
  'island-shop-shelves': [2.5, 2.3, 2],
  'walnut-upright-piano': [1.5, 1.35, 1],
  'faced-smithy-anvil': [1, 0.8, 0.5],
  'boarded-work-wagon': [5, 1.1, 2],
  'sewn-canvas-wagon': [5.5, 3, 2.5],
  'painted-stagecoach': [5, 2.6, 2],
  'rounded-grave-marker': [0.65, 1.2, 0.4],
  'beveled-grave-marker': [0.65, 1.2, 0.4],
  'stone-yard-cross': [0.65, 1.2, 0.4],
  'fitted-tapered-coffin': [2.5, 0.9, 1],
  'coopered-barrel-rack': [2, 1.3, 1],
  'two-tier-cooperage-rack': [2.5, 2.3, 2],
  'twine-bound-straw-bale': [1.05, 0.5, 0.8],
} as const

const fittedByKind: Partial<Record<Cover['kind'], keyof typeof dimensions>> = {
  trough: 'stave-horse-trough',
  boxcar: 'board-and-batten-freight-car',
  bed: 'linen-hotel-bed',
  bench: 'mortised-plank-bench',
  stove: 'potbelly-stove',
  safe: 'riveted-cash-safe',
  workbench: 'mortised-shop-workbench',
  forge: 'square-cut-smithy-hearth',
  wagon: 'boarded-work-wagon',
  covered_wagon: 'sewn-canvas-wagon',
  stagecoach: 'painted-stagecoach',
  coffins: 'fitted-tapered-coffin',
  hay: 'twine-bound-straw-bale',
  piano: 'walnut-upright-piano',
  anvil: 'faced-smithy-anvil',
}

function roomAt(x: number, z: number, buildings: TownLayout['buildings']) {
  return buildings.find(
    ({ x: left, z: top, w, d }) => x > left && x < left + w && z > top && z < top + d,
  )
}

function furnitureName(
  cover: Cover,
  buildings: TownLayout['buildings'],
): keyof typeof dimensions | undefined {
  const fitted = fittedByKind[cover.kind]
  if (fitted) {
    return fitted
  }
  if (cover.kind === 'barrel_rack') {
    return (cover.top ?? 0) >= 2 ? 'two-tier-cooperage-rack' : 'coopered-barrel-rack'
  }
  if (cover.kind === 'headstone') {
    const rows = ['rounded-grave-marker', 'beveled-grave-marker', 'stone-yard-cross'] as const
    return rows[Math.round(cover.x / 3 + cover.z) % rows.length]
  }
  if (cover.kind === 'shelves') {
    const room = roomAt(cover.x + cover.w / 2, cover.z + cover.d / 2, buildings)
    // The tall rack behind the saloon bar is part of its fitted bar assembly.
    if (room?.kind === 'saloon') {
      return undefined
    }
    return Math.min(cover.w, cover.d) > 1 ? 'island-shop-shelves' : 'wall-stock-shelves'
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
  if (name.includes('straw')) {
    return 'straw'
  }
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

function wallFacing(
  site: Cover,
  room: TownLayout['buildings'][number] | undefined,
  turned: boolean,
): number {
  if (!room) {
    return turned ? Math.PI / 2 : 0
  }
  if (turned) {
    const inward = room.x + room.w / 2 >= site.x + site.w / 2 ? 1 : -1
    return (inward * Math.PI) / 2
  }
  return room.z + room.d / 2 >= site.z + site.d / 2 ? 0 : Math.PI
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
  const byWall = name === 'wall-stock-shelves' || name === 'walnut-upright-piano'
  const turned =
    (byWall && fixture.d > fixture.w) ||
    (name === 'linen-hotel-bed' && fixture.w > fixture.d) ||
    ([
      'mortised-plank-bench',
      'stave-horse-trough',
      'board-and-batten-freight-car',
      'fitted-tapered-coffin',
    ].includes(name) &&
      fixture.d > fixture.w)
  let orientation = furnitureFacing(name, x, z, buildings)
  if (byWall) {
    orientation = wallFacing(fixture, roomAt(x, z, buildings), turned)
  } else if (turned) {
    orientation = Math.PI / 2
  }
  const [siteWidth, siteDepth] = turned ? [fixture.d, fixture.w] : [fixture.w, fixture.d]
  return doc
    .createNode(`frontier-furniture:${name}:${index}`)
    .setTranslation([x, bottom, z])
    .setRotation([0, Math.sin(orientation / 2), 0, Math.cos(orientation / 2)])
    .setScale([siteWidth / width, ((fixture.top ?? 1) - bottom) / height, siteDepth / depth])
}

function furnitureCells(site: Cover) {
  if (site.kind !== 'hay') {
    return [site]
  }
  const bottom = site.y0 ?? 0
  const [width, height, depth] = dimensions['twine-bound-straw-bale']
  const columns = Math.max(1, Math.round(site.w / width))
  const rows = Math.max(1, Math.round(site.d / depth))
  const rise = (site.top ?? 1) - bottom
  const layers = Math.max(1, Math.round(rise / height))
  const w = site.w / columns
  const d = site.d / rows
  const h = rise / layers
  return Array.from({ length: columns * rows * layers }, (_, cell) => {
    const y0 = bottom + Math.floor(cell / (columns * rows)) * h
    return {
      ...site,
      x: site.x + (Math.floor(cell / rows) % columns) * w,
      z: site.z + (cell % rows) * d,
      w,
      d,
      y0,
      top: y0 + h,
    }
  })
}

function reuseFurnitureScans(
  geometry: FrontierGeometry,
  art: Document,
  copied: ReturnType<typeof copyToDocument>,
): void {
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
  reuseFurnitureScans(geometry, art, copied)

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
    for (const [cell, placementSite] of furnitureCells(fixture).entries()) {
      const placement = furniturePlacement(geometry.doc, placementSite, layout.buildings, {
        name,
        index,
      })
      if (fixture.kind === 'hay') {
        placement.setName(`${placement.getName()}:${cell}`)
      }
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
  }
  for (const part of parts) {
    copied.get(part)?.dispose()
  }
}
