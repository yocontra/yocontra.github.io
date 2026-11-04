/**
 * First person on the small tiers: the eye sits low and looks along the ground, so every plant
 * chunk out to the far plane is in frame, each one a draw, and past ~60 m a bush is a few pixels
 * half lost in the haze. Chunks whose nearest edge lies past the tier's reach are hidden.
 */
import type { Mesh, Object3D } from 'three'
import type { Quality } from '../../engine/tiers.ts'

export interface FloraChunk {
  obj: Object3D
  x: number
  z: number
  r: number
}

/** Nearest-edge reach (m) per tier in first person; 0 keeps everything. */
export const FIRST_FLORA_M: Record<Quality, number> = { high: 0, medium: 0, floor: 62, legacy: 52 }

/** The plant chunk meshes under the wilds' root, with their world bounds. */
export function floraChunks(root: Object3D): FloraChunk[] {
  const out: FloraChunk[] = []
  root.updateMatrixWorld(true)
  for (const o of root.children) {
    const s = (o as Mesh).geometry?.boundingSphere
    if (o.name === 'flora' && s) {
      const c = s.center.clone().applyMatrix4(o.matrixWorld)
      out.push({ obj: o, x: c.x, z: c.z, r: s.radius })
    }
  }
  return out
}

/** Hide the chunks past `reach` from (x, z); reach 0 shows them all. */
export function cullFlora(
  chunks: readonly FloraChunk[],
  x: number,
  z: number,
  reach: number,
): void {
  for (const c of chunks) {
    c.obj.visible = reach === 0 || Math.hypot(c.x - x, c.z - z) - c.r < reach
  }
}
