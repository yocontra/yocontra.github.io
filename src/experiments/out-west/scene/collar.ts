/**
 * The neck inside a standing collar. Several bases (suit, punk, rugged, king) wear a mandarin
 * collar: a band of cloth round the neck whose inside is drawn (characters are double-sided, see
 * shade.ts). As sculpted, the neck skin pokes through that band in places, and seen from above,
 * three-quarter or the side the crossing reads as a saw-toothed line of dark shards along the
 * collar.
 *
 * The fix is at the source, on the bind mesh: the skin of the neck below the collar's top edge is
 * drawn a few millimetres in toward the neck's axis, so it always lies inside the cloth. Above the
 * collar (all you ever see of the neck) nothing moves, and the pull fades in over a short band so
 * there is no step. Every man, the player included, gets it before he is measured.
 */

import type { Object3D } from 'three'
import { type SkinnedMesh, Vector3 } from 'three'
import { bindBones, matName, skinnedOf, weightsOf } from './bind.ts'

/** Garments whose neck-weighted vertices form a collar. */
const CLOTH = new Set(['Shirt', 'Sleeves'])
/** How far in the neck is drawn under the collar, as a fraction of its distance from the axis. */
const TUCK = 0.14

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The height of a standing collar's band (bind space), or null for an open neck. */
function collarBand(meshes: readonly SkinnedMesh[]): { top: number; bottom: number } | null {
  const v = new Vector3()
  let top = Number.NEGATIVE_INFINITY
  let bottom = Number.POSITIVE_INFINITY
  for (const sm of meshes.filter((m) => CLOTH.has(matName(m)))) {
    const pos = sm.geometry.getAttribute('position')
    for (let k = 0; k < pos.count; k++) {
      if ((weightsOf(sm, k, ['Neck']).get('Neck') ?? 0) > 0.3) {
        v.fromBufferAttribute(pos, k).applyMatrix4(sm.bindMatrix)
        top = Math.max(top, v.y)
        bottom = Math.min(bottom, v.y)
      }
    }
  }
  return Number.isFinite(top) && top - bottom > 1e-4 ? { top, bottom } : null
}

/**
 * Is this skin vertex part of the neck the collar wraps? The neck bone's skin all round; the
 * chest's only behind the neck (the nape and the top of the back): in front, chest skin is what
 * shows in a V neck and must not dent.
 */
function wrapped(sm: SkinnedMesh, k: number, behind: boolean): boolean {
  const w = weightsOf(sm, k, ['Neck', 'Chest'])
  return (w.get('Neck') ?? 0) >= 0.3 || (behind && (w.get('Chest') ?? 0) >= 0.4)
}

/** Draw the neck skin under a standing collar in toward the neck, on the bind mesh. */
export function tuckNeck(model: Object3D): void {
  const meshes = skinnedOf(model)
  const first = meshes[0]
  const neck = first ? bindBones(first).get('Neck') : undefined
  const band = collarBand(meshes)
  if (!(neck && band)) {
    // no standing collar (a V neck, an open shirt): nothing to tuck
    return
  }
  const { top, bottom } = band
  const fade = Math.max(0.004, 0.25 * (top - bottom))
  const v = new Vector3()
  for (const sm of meshes.filter((m) => matName(m) === 'Skin')) {
    sm.geometry = sm.geometry.clone()
    const pos = sm.geometry.getAttribute('position')
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(sm.bindMatrix)
      if (v.y > top + 0.002 || v.y < bottom - fade || !wrapped(sm, k, v.z < neck.z)) {
        continue
      }
      // full tuck inside the band, fading out to nothing at its top edge and below its bottom
      const s = 1 - TUCK * smooth(top + 0.002, top - fade, v.y) * smooth(bottom - fade, bottom, v.y)
      v.set(neck.x + (v.x - neck.x) * s, v.y, neck.z + (v.z - neck.z) * s)
      v.applyMatrix4(sm.bindMatrixInverse)
      pos.setXYZ(k, v.x, v.y, v.z)
    }
    pos.needsUpdate = true
  }
}
