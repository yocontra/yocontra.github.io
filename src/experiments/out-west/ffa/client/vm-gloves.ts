/**
 * The first-person arms, dressed for the lens: the source bodies are built to read at street
 * distance, so up close the hands are faceted and bare. For the view model only, a copy of the
 * body gets:
 *
 * - leather gloves and gauntlet cuffs: every vertex the hand bones carry (and the forearm's last
 *   stretch before the wrist) is tinted saddle brown, off the skin path (no skin wrap or blush),
 *   a little glossier;
 * - smooth shading: normals rebuilt with a crease angle, so the low-poly hands and sleeves read as
 *   rounded forms instead of facets (hard edges past the crease stay hard).
 */
import type { BufferAttribute, BufferGeometry, Skeleton } from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const HAND = /^(?:Wrist|Index|Middle|Ring|Pinky|Thumb)\d?[LR]$/u
const FOREARM = /^LowerArm[LR]$/u
/** Saddle leather, multiplied over the atlas's skin. */
const LEATHER = [0.46, 0.3, 0.19] as const
/** Material params for the glove (styMat: roughness factor, rim strength; no skin flag). */
const GLOVE_MAT = [0.75, 0.55] as const
const CREASE = (70 * Math.PI) / 180

export function dressForLens(geo: BufferGeometry, skeleton: Skeleton): BufferGeometry {
  const g = geo.clone()
  const idx = g.getAttribute('skinIndex') as BufferAttribute | undefined
  const w = g.getAttribute('skinWeight') as BufferAttribute | undefined
  const color = g.getAttribute('color') as BufferAttribute | undefined
  const mat = g.getAttribute('styMat') as BufferAttribute | undefined
  const lum = g.getAttribute('styLum') as BufferAttribute | undefined
  if (idx && w && color) {
    const hand = skeleton.bones.map((b) => HAND.test(b.name))
    const fore = skeleton.bones.map((b) => FOREARM.test(b.name))
    for (let v = 0; v < idx.count; v++) {
      let onHand = 0
      let onFore = 0
      for (let k = 0; k < 4; k++) {
        const bone = idx.getComponent(v, k)
        const wt = w.getComponent(v, k)
        if (hand[bone]) {
          onHand += wt
        } else if (fore[bone]) {
          onFore += wt
        }
      }
      // the glove, and its cuff where the forearm hands over to the wrist
      if (onHand > 0.45 || (onHand > 0.08 && onFore > 0.3)) {
        color.setXYZ(v, LEATHER[0], LEATHER[1], LEATHER[2])
        mat?.setXY(v, GLOVE_MAT[0], GLOVE_MAT[1])
        lum?.setX(v, 0)
      }
    }
    color.needsUpdate = true
  }
  const smooth = toCreasedNormals(g, CREASE)
  g.dispose()
  return smooth
}
