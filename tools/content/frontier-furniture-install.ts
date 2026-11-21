/** Fit Blender furniture to Frontier cover sites and reuse the existing town scans. */
import { Material, Node } from '@gltf-transform/core'
import { copyToDocument } from '@gltf-transform/functions'
import type { Cover, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { type FrontierGeometry, frontierIO } from './frontier-geometry.ts'

const dimensions = {
  'saloon-card-table': [1.5, 0.8, 1.5],
  'scrubbed-work-table': [2, 0.8, 1],
  'potbelly-stove': [1, 1.1, 1],
} as const

function furnitureName(cover: Cover): keyof typeof dimensions | undefined {
  if (cover.kind === 'stove') {
    return 'potbelly-stove'
  }
  if (cover.kind === 'table') {
    const inSaloon = cover.x >= 23 && cover.x < 42 && cover.z >= 32 && cover.z < 44
    return inSaloon && !cover.y0 ? 'saloon-card-table' : 'scrubbed-work-table'
  }
  return undefined
}

export function hasFittedFurniture(cover: Cover): boolean {
  return furnitureName(cover) !== undefined
}

function scannedMaterial(name: string): string | undefined {
  if (name.includes('walnut') || name.includes('oak')) {
    return 'floor'
  }
  if (name.includes('iron')) {
    return 'iron'
  }
  return name.endsWith('baize') ? 'cloth' : undefined
}

function stoveFacing(x: number, z: number, buildings: TownLayout['buildings']): number {
  const room = buildings.find(
    ({ x: left, z: top, w, d }) => x > left && x < left + w && z > top && z < top + d,
  )
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

export async function installFrontierFurniture(
  geometry: FrontierGeometry,
  layout: TownLayout,
  path: string,
): Promise<void> {
  const art = await frontierIO.read(path)
  const models = art.getRoot().getDefaultScene()?.listChildren() ?? []
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
    const name = furnitureName(fixture)
    if (!name) {
      continue
    }
    const template = models.find((model) => model.getName() === name)
    if (!template?.listChildren().length) {
      throw new Error(`Missing authored Frontier furniture ${name}`)
    }
    const [width, height, depth] = dimensions[name]
    const bottom = fixture.y0 ?? 0
    const x = fixture.x + fixture.w / 2
    const z = fixture.z + fixture.d / 2
    const orientation = name === 'potbelly-stove' ? stoveFacing(x, z, layout.buildings) : 0
    const placement = geometry.doc
      .createNode(`frontier-furniture:${name}:${index}`)
      .setTranslation([x, bottom, z])
      .setRotation([0, Math.sin(orientation / 2), 0, Math.cos(orientation / 2)])
      .setScale([fixture.w / width, ((fixture.top ?? 1) - bottom) / height, fixture.d / depth])
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
