/** Catalog detail framing follows referenced vertices of the actual posed equipped feature. */
import { Box3, Vector3 } from 'three'
import type { Actor } from './actor.ts'

export function badgeBounds(actor: Actor): Box3 {
  const box = new Box3()
  const point = new Vector3()
  actor.root.updateMatrixWorld(true)
  for (const mesh of actor.meshes) {
    const ranges = mesh.geometry.userData.badgeRanges as
      | { start: number; count: number }[]
      | undefined
    const referenced = new Set(mesh.geometry.index?.array ?? [])
    for (const range of ranges ?? []) {
      for (let vertex = range.start; vertex < range.start + range.count; vertex++) {
        if (referenced.has(vertex)) {
          mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld)
          box.expandByPoint(point)
        }
      }
    }
  }
  return box
}
