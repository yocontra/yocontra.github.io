/** Install the Blender-authored bar and lamps using the town's existing wood scans. */
import { join } from 'node:path'
import { Material, Node } from '@gltf-transform/core'
import { copyToDocument } from '@gltf-transform/functions'
import type { Building, Cover, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { hasFittedFurniture, installFrontierFurniture } from './frontier-furniture-install.ts'
import { type FrontierGeometry, frontierIO, type Rgb } from './frontier-geometry.ts'
import { coverModel } from './frontier-props.ts'

function isSaloonBar(cover: Cover): boolean {
  return (
    (cover.kind === 'counter' && cover.x === 26.2 && cover.z === 34) ||
    (cover.kind === 'shelves' && cover.x === 24.75 && cover.z === 34)
  )
}

export function authorCover(geometry: FrontierGeometry, root: Node, layout: TownLayout): void {
  const { cover, buildings } = layout
  const saloonFixtures = cover.filter(isSaloonBar)
  if (saloonFixtures.length !== 2) {
    throw new Error('The saloon bar no longer matches its cover locations')
  }
  for (const [index, placement] of cover.entries()) {
    if (!(isSaloonBar(placement) || hasFittedFurniture(placement, buildings))) {
      coverModel(geometry, root, placement, index)
    }
  }
}

export async function installPeriodFixtures(
  geometry: FrontierGeometry,
  layout: TownLayout,
  directory: string,
): Promise<void> {
  await installSaloonBar(geometry, join(directory, 'frontier-saloon.glb'))
  await installFrontierFurniture(geometry, layout, [
    join(directory, 'frontier-furniture.glb'),
    join(directory, 'frontier-freight.glb'),
    join(directory, 'frontier-shop-fixtures.glb'),
    join(directory, 'frontier-room-fittings.glb'),
    join(directory, 'frontier-transport.glb'),
  ])
}

async function installSaloonBar(geometry: FrontierGeometry, source: string): Promise<void> {
  const art = await frontierIO.read(source)
  const fixtures = art.getRoot().getDefaultScene()?.listChildren()
  if (!fixtures?.length) {
    throw new Error('Missing the authored saloon fixtures')
  }
  const copied = copyToDocument(geometry.doc, art, fixtures)
  const root = geometry.group('Perdition saloon bar and interior lanterns')
  for (const original of fixtures) {
    const node = copied.get(original)
    if (!(node instanceof Node)) {
      throw new Error(`Could not copy saloon fixture ${original.getName()}`)
    }
    root.addChild(node)
  }

  const boards = geometry.materials.get('floor')
  if (!(boards?.getBaseColorTexture() && boards.getNormalTexture())) {
    throw new Error('Missing the shared floorboard scan for the saloon bar')
  }
  for (const material of art.getRoot().listMaterials()) {
    if (!(material.getName().startsWith('Saloon ') && material.getName().includes('walnut'))) {
      continue
    }
    const surface = copied.get(material)
    if (!(surface instanceof Material)) {
      throw new Error(`Could not copy saloon surface ${material.getName()}`)
    }
    surface
      .setBaseColorTexture(boards.getBaseColorTexture())
      .setNormalTexture(boards.getNormalTexture())
      .setNormalScale(0.42)
      .setOcclusionTexture(boards.getOcclusionTexture())
  }
}

/** Floorboard wear and contact darkening baked into both graphics tiers. */
export function saloonFloor(
  geometry: FrontierGeometry,
  root: Node,
  floor: Building,
  cover: readonly Cover[],
): void {
  const { x, z, w, d } = floor
  const fixtures = cover.filter(
    (item) =>
      !(item.y0 && item.y0 > 0.1) &&
      item.x >= x &&
      item.z >= z &&
      item.x + item.w <= x + w &&
      item.z + item.d <= z + d,
  )
  const positions: number[] = []
  const indices: number[] = []
  const colors: number[] = []
  const tint: Rgb = [0.78, 0.67, 0.51]
  // Vertices resolve soft contact at fixture feet without pushing geometry above the floor.
  const columns = Math.ceil(w * 4) + 1
  const rows = Math.ceil(d * 4) + 1
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const px = x + (column * w) / (columns - 1)
      const pz = z + (row * d) / (rows - 1)
      let shadow = 0
      for (const item of fixtures) {
        const dx = Math.max(item.x - px, px - item.x - item.w, 0)
        const dz = Math.max(item.z - pz, pz - item.z - item.d, 0)
        const reach = item.kind === 'table' ? 0.22 : 0.36
        const weight = item.kind === 'table' ? 0.16 : 0.26
        shadow = Math.max(shadow, weight * Math.exp(-((dx * dx + dz * dz) / (reach * reach))))
      }
      const edge = Math.min(px - x, pz - z, x + w - px, z + d - pz)
      const entry = Math.exp(-(((px - 30) / 1.6) ** 2 + ((pz - 43) / 2.3) ** 2))
      const grain = Math.sin(px * 0.73 + pz * 1.49) * Math.sin(pz * 2.21) * 0.021
      const tone = 1 - shadow - 0.1 * Math.exp(-edge * 4) + 0.14 * entry + grain
      positions.push(px, 0.03, pz)
      colors.push(...tint.map((channel) => channel * tone), 1)
      if (row < rows - 1 && column < columns - 1) {
        const corner = row * columns + column
        indices.push(
          corner,
          corner + columns,
          corner + columns + 1,
          corner,
          corner + columns + 1,
          corner + 1,
        )
      }
    }
  }
  geometry.surface(root, 'floor', { id: 'saloon-floor', positions, indices, colors })
}
