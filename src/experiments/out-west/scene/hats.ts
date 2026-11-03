/**
 * Hats as lathed felt: a silhouette per hat key, a crown pinch, a band, one merged mesh. Shared by
 * the duel's actors and Frontier's instanced crowd hats.
 */
import {
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  SplineCurve,
  Vector2,
} from 'three'
import type { HatKey } from '../data/outlaws.ts'
import { mergePieces, meshPieces } from './bake.ts'
import { characterMaterial } from './shade.ts'
import type { Floor } from './style.ts'

/** Hat silhouettes from lathe profiles (x = radius, y = height), metres. */
const HAT_PROFILES: Record<HatKey, [number, number][]> = {
  cowboy: [
    [0.0, 0.14],
    [0.06, 0.145],
    [0.085, 0.12],
    [0.1, 0.03],
    [0.12, 0.012],
    [0.17, 0.0],
    [0.205, 0.02],
    [0.215, 0.045],
  ],
  bowler: [
    [0.0, 0.125],
    [0.06, 0.118],
    [0.092, 0.08],
    [0.1, 0.02],
    [0.13, 0.008],
    [0.148, 0.02],
  ],
  sombrero: [
    [0.0, 0.2],
    [0.05, 0.19],
    [0.08, 0.1],
    [0.1, 0.02],
    [0.25, 0.0],
    [0.34, 0.02],
    [0.36, 0.07],
  ],
  tophat: [
    [0.0, 0.2],
    [0.088, 0.2],
    [0.082, 0.1],
    [0.09, 0.012],
    [0.13, 0.0],
    [0.145, 0.018],
  ],
  tall: [
    [0.0, 0.2],
    [0.05, 0.205],
    [0.08, 0.18],
    [0.095, 0.03],
    [0.12, 0.012],
    [0.17, 0.0],
    [0.215, 0.012],
    [0.225, 0.035],
  ],
  flat: [
    [0.0, 0.095],
    [0.095, 0.095],
    [0.1, 0.02],
    [0.13, 0.006],
    [0.185, 0.0],
    [0.19, 0.012],
  ],
}

/** Inner radius of each crown where it meets the head (the profile point above the brim). */
export const CROWN_R: Record<HatKey, number> = {
  cowboy: 0.1,
  bowler: 0.1,
  sombrero: 0.1,
  tophat: 0.09,
  tall: 0.095,
  flat: 0.1,
}

/**
 * Give a lathed hat its hand-made shape: a cattleman's brim rolls up at the sides and dips
 * front and back, and its crown takes a centre crease; the flat-brims keep theirs flat.
 */
function shapeHat(geo: LatheGeometry, key: HatKey): void {
  const crownR = CROWN_R[key] ?? 0.1
  const prof = HAT_PROFILES[key] ?? HAT_PROFILES.cowboy
  const brimR = Math.max(...prof.map(([x]) => x))
  const top = Math.max(...prof.map(([, y]) => y))
  const curl = { cowboy: 0.05, tall: 0.045, sombrero: 0.02 }[key as string] ?? 0
  const crease = { cowboy: 0.022, tall: 0.018 }[key as string] ?? 0
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    let y = pos.getY(i)
    const rr = Math.hypot(x, z)
    if (rr > crownR + 0.008 && curl > 0) {
      const t = (rr - crownR) / Math.max(0.01, brimR - crownR)
      const side = (x / rr) ** 2
      y += curl * t * t * side - curl * 0.35 * t * t * (1 - side)
    }
    if (crease > 0 && y > top - 0.05) {
      const k = (y - (top - 0.05)) / 0.05
      y -= crease * k * Math.max(0, 1 - Math.abs(x) / (crownR * 0.9))
    }
    pos.setY(i, y)
  }
  geo.computeVertexNormals()
}

/**
 * A hat as ONE mesh (crown and band merged, vertex coloured). The returned
 * group is what pops off; `fit` scales an inner child so popHat() keeps size.
 */
export function makeHat(key: HatKey, color: number, floor: Floor = { value: 0 }): Group {
  const pts = (HAT_PROFILES[key] ?? HAT_PROFILES.cowboy).map(([x, y]) => new Vector2(x, y))
  // lathe needs the profile ordered bottom→top for outward normals; a spline through the
  // profile rounds the crown and the brim's roll instead of faceting them
  const prof = new SplineCurve([...pts].reverse()).getSpacedPoints(36)
  const g = new Group()
  const felt = new MeshStandardMaterial({ color, roughness: 0.85 })
  felt.userData.rim = 0.9
  felt.userData.swatch = 'felt'
  const lathe = new LatheGeometry(prof, 48)
  shapeHat(lathe, key)
  const crown = new Mesh(lathe, felt)
  g.add(crown)
  const bandH = key === 'sombrero' ? 0.03 : 0.022
  const r = (HAT_PROFILES[key]?.[2]?.[0] ?? 0.09) + 0.006
  const bandMat = new MeshStandardMaterial({
    color: new Color(color).multiplyScalar(0.35),
    roughness: 0.6,
  })
  bandMat.userData.swatch = 'leather'
  const band = new Mesh(new CylinderGeometry(r, r + 0.004, bandH, 48, 1, true), bandMat)
  band.position.y = 0.03
  g.add(band)
  const geo = mergePieces(meshPieces(g, g))
  const mat = characterMaterial(floor, 'Felt')
  mat.side = DoubleSide
  const mesh = new Mesh(geo, mat)
  mesh.castShadow = true
  const out = new Group()
  const inner = new Group()
  inner.add(mesh)
  out.add(inner)
  // Crumple the brim a touch so it doesn't read as CG-perfect.
  out.rotation.z = (Math.random() - 0.5) * 0.06
  return out
}
