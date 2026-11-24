/** Install the Blender joinery and small fittings on their canonical furniture and stair sites. */
import { join } from 'node:path'
import { Material, Node } from '@gltf-transform/core'
import { copyToDocument } from '@gltf-transform/functions'
import { type FrontierGeometry, frontierIO } from './frontier-geometry.ts'

export async function installUpperRoomDetails(geometry: FrontierGeometry, directory: string) {
  const art = await frontierIO.read(join(directory, 'frontier-upper-rooms.glb'))
  const rooms = art.getRoot().getDefaultScene()?.listChildren()
  if (rooms?.length !== 4) {
    throw new Error('Expected upper-room fittings for the saloon, hotel, bank and belfry')
  }
  const copied = copyToDocument(geometry.doc, art, rooms)
  // The authored UVs follow the stair nosings, cabinet grain and woven rug borders.
  // Share the same texture objects used in the surrounding room to keep the native budget.
  for (const material of art.getRoot().listMaterials()) {
    const role = material.getExtras().surface
    const target = copied.get(material)
    if (typeof role === 'string' && target instanceof Material) {
      const scan = geometry.material(role)
      target
        .setBaseColorTexture(scan.getBaseColorTexture())
        .setNormalTexture(scan.getNormalTexture())
        .setNormalScale(0.45)
        .setOcclusionTexture(scan.getOcclusionTexture())
    }
  }
  const root = geometry.group('Perdition upper rooms')
  for (const room of rooms) {
    const node = copied.get(room)
    if (!(node instanceof Node)) {
      throw new Error(`Missing upper-room detail for ${room.getName()}`)
    }
    root.addChild(node)
  }
}
