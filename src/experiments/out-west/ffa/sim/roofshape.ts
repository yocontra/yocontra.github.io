// biome-ignore-all lint/complexity/useMaxParams: the roof math takes its coordinates positionally
/**
 * The pitched roof shape the sim and the scene share. `b.roof` is written by the town plan; the
 * scene builds the mesh from it and the sim walks on `roofHeightAt`, so the two can never drift.
 */
import type { Building, RoofSpec, Side } from './layout.ts'

/** The roof spec a building kind gets, matching the scene's old inline choices. */
export function roofSpecFor(
  b: Building,
  falseFront: boolean,
  front: Side,
  span: number,
  bays: number,
): RoofSpec {
  if (falseFront) {
    return {
      axis: front === 'n' || front === 's' ? 'z' : 'x',
      rise: Math.min(1.45, (span / bays / 2) * 0.55),
      bays,
      overhang: 0.35,
      front,
    }
  }
  return {
    axis: b.w >= b.d ? 'x' : 'z',
    rise: Math.min(b.w, b.d) * 0.32,
    bays: 1,
    overhang: 0.5,
    front: null,
  }
}

/** Roof surface height at (x, z), metres. Outside the footprint it returns the eave height. */
export function roofHeightAt(b: Building, x: number, z: number): number {
  const spec = b.roof
  if (!spec) {
    return b.height
  }
  const alongX = spec.axis === 'x'
  const c = alongX ? z : x
  const c0 = alongX ? b.z : b.x
  const c1 = alongX ? b.z + b.d : b.x + b.w
  const span = (c1 - c0) / Math.max(1, spec.bays)
  const half = span / 2
  const slope = spec.rise / Math.max(1e-6, half)
  const k = Math.min(spec.bays - 1, Math.max(0, Math.floor((c - c0) / Math.max(1e-6, span))))
  const cm = c0 + k * span + half
  return b.height + spec.rise - Math.abs(c - cm) * slope
}

/** The roof's slope as rise/run, for the walkable-slope check. */
export function roofSlopeAt(b: Building): number {
  const spec = b.roof
  if (!spec) {
    return 0
  }
  const alongX = spec.axis === 'x'
  const c0 = alongX ? b.z : b.x
  const c1 = alongX ? b.z + b.d : b.x + b.w
  const span = (c1 - c0) / Math.max(1, spec.bays)
  const half = span / 2
  return spec.rise / Math.max(1e-6, half)
}
