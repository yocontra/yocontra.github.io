import type { Node } from '@gltf-transform/core'
import type { Building } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { type FrontierGeometry, frontierIO } from './frontier-geometry.ts'

export async function dressWaterTower(
  g: FrontierGeometry,
  root: Node,
  building: Building,
  path: string,
): Promise<void> {
  const art = await frontierIO.read(path)
  const { id, x, w, z, d, height } = building
  if (w !== 4 || d !== 4 || height !== 12) {
    throw new Error('The fitted water tank and its structural envelope have different sizes')
  }
  for (const mesh of art.getRoot().listMeshes()) {
    for (const piece of mesh.listPrimitives()) {
      const material = piece.getMaterial()
      const points = piece.getAttribute('POSITION')
      const uvs = piece.getAttribute('TEXCOORD_0')?.getArray()
      const indices = piece.getIndices()?.getArray()
      if (!(material && points && uvs && indices)) {
        throw new Error('The water tower is missing its authored geometry or finish')
      }
      const role = material.getMetallicFactor() > 0.25 ? 'iron' : 'wood'
      const [red, green, blue] = material.getBaseColorFactor()
      const positions: number[] = []
      for (let i = 0; i < points.getCount(); i++) {
        const [px = 0, py = 0, pz = 0] = points.getElement(i, [])
        positions.push(x + w / 2 + px, py, z + d / 2 + pz)
      }
      // The town's timber scan follows V. Blender records the long grain in U.
      const grain = Array.from(uvs, (value, i) => (role === 'wood' ? (uvs[i ^ 1] ?? value) : value))
      g.surface(root, role, { id, positions, uvs: grain, indices: [...indices] }, [
        red,
        green,
        blue,
      ])
    }
  }
}
