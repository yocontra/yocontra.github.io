/** Preserved authored outskirts: one continuous frame shared by terrain and all vegetation. */
import ground from '../art/environments/frontier-ground.json' with { type: 'json' }
import type { CollisionMesh } from './frontier-collision.ts'

export function frontierFlatGround(size: number) {
  return { x: -48, z: -48, w: size + 96, d: size + 96, y0: -0.06, top: 0 }
}

export function frontierGroundTransform(size: number) {
  return {
    scale: (size + ground.apron * 2) / ground.originalSize,
    translation: [-ground.apron, -0.005, -ground.apron] as [number, number, number],
  }
}

export function frontierGround(size: number): CollisionMesh[] {
  const { scale, translation } = frontierGroundTransform(size)
  return ground.meshes.map((mesh, index) => ({
    id: `outskirts:${index}`,
    positions: mesh.positions.map(
      (value, component) => value * scale + (translation[component % 3] ?? 0),
    ),
    indices: mesh.indices,
  }))
}
