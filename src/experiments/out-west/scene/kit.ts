// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * The leather and iron an actor carries: the holster cosmetic's look (scene/gunbelt.ts builds it),
 * and guns merged into one mesh. Looks only: a holster never moves the gun's seat, so the draw is
 * the same for everyone.
 */

import { Group, Mesh, MeshStandardMaterial, type Object3D } from 'three'
import { meshPieces } from './bake.ts'
import { mergePieces } from './piece-merge.ts'

/**
 * How a holster and its gunbelt look (scene/holster.ts fits them). Pure leatherwork: the gun's
 * seat, and so the draw, never moves.
 * - `trim`: a contrasting band at the mouth and the toe (tooled leather), and the buckle.
 * - `rig`: a buscadero: a wider belt and a broad drop loop down to the holster.
 */
export interface HolsterLook {
  color: number
  roughness?: number
  trim?: number
  rig?: boolean
  detail?: 'floral' | 'conchos'
}

/** The starter holster: plain dark leather. */
export const PLAIN_HOLSTER: HolsterLook = { color: 0x3a_24_14, roughness: 0.55 }

/**
 * A gun as ONE mesh (its parts merged, vertex coloured, its own metal look):
 * one draw call in the holster or the hand instead of one per part.
 */
export function mergedProp(src: Object3D): Object3D {
  const g = src.clone()
  g.updateMatrixWorld(true)
  let textured = false
  g.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh && (m.material as MeshStandardMaterial).map) {
      textured = true
    }
  })
  if (textured) {
    return g
  }
  const pieces = meshPieces(g, g)
  const metal = new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.55 })
  const mesh = new Mesh(mergePieces(pieces), metal)
  mesh.castShadow = true
  const out = new Group()
  out.name = src.name
  out.add(mesh)
  return out
}
