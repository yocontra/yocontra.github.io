// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * The leather and iron an actor carries: the holster cosmetic's look and parts, and guns merged into
 * one mesh. Looks only: a holster never moves the gun's slot, so the draw is the same for everyone.
 */
import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three'
import { mergePieces, meshPieces } from './bake.ts'

/**
 * How a holster looks. Pure leatherwork: the gun's slot, and so the draw, never moves.
 * - `trim`: a contrasting band at the mouth and the toe (tooled leather).
 * - `rig`: a buscadero drop loop from the belt down to the holster.
 */
export interface HolsterLook {
  color: number
  roughness?: number
  trim?: number
  rig?: boolean
}

/** The starter holster: plain dark leather. */
export const PLAIN_HOLSTER: HolsterLook = { color: 0x3a_24_14, roughness: 0.55 }

/**
 * The holster's leather in its slot's frame (the barrel lies along +X, 0.045 up +Y). The body
 * cylinder is the same for every holster; tooling adds bands, a buscadero rig adds the drop loop
 * that hangs it from the belt.
 */
export function holsterParts(look: HolsterLook): Mesh[] {
  const leather = new MeshStandardMaterial({ color: look.color, roughness: look.roughness ?? 0.55 })
  leather.userData.swatch = 'leather'
  const body = new Mesh(new CylinderGeometry(0.03, 0.026, 0.2, 7), leather)
  body.rotation.z = Math.PI / 2
  body.position.set(0.13, 0.045, 0)
  const parts = [body]
  if (look.trim !== undefined) {
    const band = new MeshStandardMaterial({ color: look.trim, roughness: 0.4, metalness: 0.3 })
    band.userData.swatch = 'metal'
    for (const [x, r] of [
      [0.04, 0.032],
      [0.215, 0.028],
    ] as const) {
      const ring = new Mesh(new CylinderGeometry(r, r, 0.016, 7), band)
      ring.rotation.z = Math.PI / 2
      ring.position.set(x, 0.045, 0)
      parts.push(ring)
    }
  }
  if (look.rig) {
    // a flat strap on the outer face (-Y, away from the leg), from the belt (-X, up the thigh)
    // down past the mouth of the holster; local X becomes the thickness once rotated
    const strap = new Mesh(new CylinderGeometry(0.036, 0.036, 0.16, 6, 1), leather)
    strap.scale.set(0.22, 1, 1)
    strap.rotation.z = Math.PI / 2
    strap.position.set(0.02, 0.008, 0)
    parts.push(strap)
  }
  return parts
}

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
