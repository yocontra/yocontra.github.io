/** Fitted work gloves on the source hand topology, preserving its fingers and shared rig. */
import { type BufferAttribute, Color, type SkinnedMesh } from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { intoRect, SWATCH, SWATCH_LUM } from '../../scene/atlas.ts'

const HAND = /^(?:Wrist|Index|Middle|Ring|Pinky|Thumb)\d?[LR]$/u
const LEATHER = new Color(0x51_42_31)
const CREASE = (75 * Math.PI) / 180

interface HandVertex {
  index: number
  side: number
}

function gloveTriangles(weight: Float32Array, side: Uint8Array): HandVertex[] {
  const vertices: HandVertex[] = []
  for (let t = 0; t < weight.length; t += 3) {
    let dominant = t
    for (let k = 1; k < 3; k++) {
      if ((weight[t + k] ?? 0) > (weight[dominant] ?? 0)) {
        dominant = t + k
      }
    }
    if ((weight[dominant] ?? 0) > 0.04) {
      const which = side[dominant] ?? 0
      for (let k = 0; k < 3; k++) {
        vertices.push({ index: t + k, side: which })
      }
    }
  }
  return vertices
}

/**
 * The source hands already have connected palms, thumb webs and articulated knuckles. Reusing
 * that surface avoids intersecting finger tubes and keeps the glove exactly on the gun's grip.
 * The wrist's skin blend becomes the cuff; leather uses the shared atlas and character draw.
 */
export function dressForLens(body: SkinnedMesh): void {
  const source = body.geometry
  // Whole triangles change atlas regions, so a cuff never interpolates through unrelated texels.
  const geometry = source.index ? source.toNonIndexed() : source.clone()
  const indices = geometry.getAttribute('skinIndex') as BufferAttribute
  const weights = geometry.getAttribute('skinWeight') as BufferAttribute
  const color = geometry.getAttribute('color') as BufferAttribute
  const surface = geometry.getAttribute('styMat') as BufferAttribute
  const luminance = geometry.getAttribute('styLum') as BufferAttribute
  const uv = geometry.getAttribute('uv') as BufferAttribute
  const hand = body.skeleton.bones.map((bone) => HAND.test(bone.name))
  const side = body.skeleton.bones.map((bone) => Number(bone.name.endsWith('L')))
  const handWeight = new Float32Array(indices.count)
  const handSide = new Uint8Array(indices.count)
  const regions = [
    {
      u0: Number.POSITIVE_INFINITY,
      u1: Number.NEGATIVE_INFINITY,
      v0: Number.POSITIVE_INFINITY,
      v1: Number.NEGATIVE_INFINITY,
    },
    {
      u0: Number.POSITIVE_INFINITY,
      u1: Number.NEGATIVE_INFINITY,
      v0: Number.POSITIVE_INFINITY,
      v1: Number.NEGATIVE_INFINITY,
    },
  ]
  for (let v = 0; v < indices.count; v++) {
    let onHand = 0
    let which = 0
    for (let k = 0; k < 4; k++) {
      const bone = indices.getComponent(v, k)
      if (hand[bone]) {
        onHand += weights.getComponent(v, k)
        which = side[bone] ?? 0
      }
    }
    if (onHand <= 0.04) {
      continue
    }
    handWeight[v] = onHand
    handSide[v] = which
    const region = regions[which]
    if (region && onHand > 0.5) {
      region.u0 = Math.min(region.u0, uv.getX(v))
      region.u1 = Math.max(region.u1, uv.getX(v))
      region.v0 = Math.min(region.v0, uv.getY(v))
      region.v1 = Math.max(region.v1, uv.getY(v))
    }
  }
  for (const vertex of gloveTriangles(handWeight, handSide)) {
    const i = vertex.index
    color.setXYZ(i, LEATHER.r, LEATHER.g, LEATHER.b)
    surface.setXY(i, 0.95, 0.55)
    const region = regions[vertex.side]
    if (region && Number.isFinite(region.u0)) {
      const u = Math.min(
        1,
        Math.max(0, (uv.getX(i) - region.u0) / Math.max(1e-5, region.u1 - region.u0)),
      )
      const v = Math.min(
        1,
        Math.max(0, (uv.getY(i) - region.v0) / Math.max(1e-5, region.v1 - region.v0)),
      )
      const at = intoRect(SWATCH.leather, u, v)
      uv.setXY(i, at[0], at[1])
      luminance.setX(i, SWATCH_LUM.leather)
    }
  }
  body.geometry = toCreasedNormals(geometry, CREASE)
  geometry.dispose()
  source.dispose()
}
