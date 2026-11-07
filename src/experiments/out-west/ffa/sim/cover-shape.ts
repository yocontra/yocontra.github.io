/** Shared deterministic profiles for drawn cover and physical contact. */
import type { Cover, Rect } from './layout.ts'

export const CANOPY_SEGMENTS = 18
export const CANOPY_SPANS = 12
export const WAGON_BED = 0.85
export const WAGON_WHEEL = 0.6
export const WELL_EAVE = 2.17
export const WELL_RISE = 0.4
export const WELL_CAP = 2.6

export interface ShapedCover extends Rect {
  heightAt: (x: number, z: number) => number
  /** The centre is on the continuous roof, rather than a separate low tongue or coping. */
  slopeAt: (x: number, z: number) => boolean
  /** Conservative horizontal section of the drawn solid above this world height. */
  boundsAbove: (height: number) => Rect | null
}

/** Root-local canvas point; vertical folds keep its contact profile single-valued. */
export function canopyPoint(
  c: Rect,
  bedTop: number,
  top: number,
  sample: { u: number; t: number; seam?: number },
) {
  const { u, t, seam = 0 } = sample
  const theta = t * Math.PI
  const eave = bedTop + 0.38
  const sag = Math.sin(u * Math.PI * 3) ** 2 * 0.035
  const fold = Math.sin(theta * 8 + u * 0.6) * 0.016 * Math.sin(theta * 2) ** 2
  return {
    along: (u - 0.5) * (Math.max(c.w, c.d) - 1.35) + 0.45,
    across: Math.cos(theta) * (Math.max(0.45, (Math.min(c.w, c.d) - 0.5) / 2) + seam),
    y: eave + Math.sin(theta) * (top - eave - sag + seam) + fold,
  }
}

/** Height on the authored diagonal of one canvas panel's two triangles. */
function panelHeight(heights: Float64Array, row: number, u: number, v: number) {
  const next = row + CANOPY_SEGMENTS + 1
  const y00 = heights[row] ?? 0
  const y10 = heights[next] ?? 0
  const y11 = heights[next + 1] ?? 0
  const y01 = heights[row + 1] ?? 0
  return v <= u ? y00 + u * (y10 - y00) + v * (y11 - y10) : y00 + u * (y11 - y01) + v * (y01 - y00)
}

function wagonHardwareTop(
  a: number,
  b: number,
  size: { length: number; width: number; base: number },
) {
  const { length, width, base } = size
  const bedLength = length - 1.1
  const bedWidth = width - 0.5
  const aa = Math.abs(a)
  const bb = Math.abs(b)
  let y = 0
  if (aa <= bedLength / 2 && bb <= bedWidth / 2) {
    y =
      base + WAGON_BED + 0.12 + (aa >= bedLength / 2 - 0.06 || bb >= bedWidth / 2 - 0.06 ? 0.4 : 0)
  }
  for (let sign = -1; sign <= 1; sign += 2) {
    const d = Math.abs(a - sign * (bedLength / 2 - WAGON_WHEEL - 0.1))
    if (d <= WAGON_WHEEL && Math.abs(bb - (width / 2 - 0.08)) <= 0.035) {
      y = Math.max(y, base + WAGON_WHEEL + Math.sqrt(WAGON_WHEEL ** 2 - d ** 2))
    }
    if (d <= 0.05 && bb <= (width - 0.1) / 2) {
      y = Math.max(y, base + WAGON_WHEEL + 0.05)
    }
  }
  if (Math.abs(a + bedLength / 2 + 0.5) <= 0.5 && bb <= 0.05) {
    y = Math.max(y, base + 0.45)
  }
  if (Math.abs(a + 0.45 + length / 2 - 0.1) <= 0.1 && bb <= 0.25) {
    y = Math.max(y, base + 0.35)
  }
  return y
}

function wagonShape(c: Cover): ShapedCover {
  const alongX = c.w >= c.d
  const length = Math.max(c.w, c.d)
  const width = Math.min(c.w, c.d)
  const bedWidth = width - 0.5
  const base = c.y0 ?? 0
  const size = { length, width, base }
  const bedTop = base + WAGON_BED + 0.12
  const radius = Math.max(0.45, bedWidth / 2)
  const canvasLength = length - 1.35
  const across = new Float64Array(CANOPY_SEGMENTS + 1)
  const heights = new Float64Array((CANOPY_SPANS + 1) * (CANOPY_SEGMENTS + 1))
  for (let j = 0; j <= CANOPY_SPANS; j++) {
    for (let i = 0; i <= CANOPY_SEGMENTS; i++) {
      const p = canopyPoint(c, bedTop, base + (c.top ?? 3), {
        u: j / CANOPY_SPANS,
        t: i / CANOPY_SEGMENTS,
      })
      across[i] = p.across
      heights[j * (CANOPY_SEGMENTS + 1) + i] = p.y
    }
  }
  return {
    ...c,
    slopeAt: (x, z) => {
      const a = (alongX ? x - c.x - c.w / 2 : z - c.z - c.d / 2) - 0.45
      const b = alongX ? z - c.z - c.d / 2 : x - c.x - c.w / 2
      return Math.abs(a) <= canvasLength / 2 && Math.abs(b) < radius - 0.06
    },
    boundsAbove: (height) => {
      let a0 = Number.POSITIVE_INFINITY
      let a1 = Number.NEGATIVE_INFINITY
      let b0 = Number.POSITIVE_INFINITY
      let b1 = Number.NEGATIVE_INFINITY
      const include = (a: number, halfA: number, halfB: number) => {
        a0 = Math.min(a0, a - halfA)
        a1 = Math.max(a1, a + halfA)
        b0 = Math.min(b0, -halfB)
        b1 = Math.max(b1, halfB)
      }
      const eave = bedTop + 0.38
      const peak = base + (c.top ?? 3) + 0.016
      if (height < peak) {
        // The ellipse contains the drawn chords; sag/folds change this bound by less than 5cm.
        const rise = Math.max(0, (height - eave - 0.016) / (peak - eave - 0.016))
        include(0.45, canvasLength / 2, radius * Math.sqrt(Math.max(0, 1 - rise * rise)))
      }
      if (height < bedTop + 0.4) {
        include(0.45, (length - 1.1) / 2, bedWidth / 2)
      }
      if (height < base + WAGON_WHEEL * 2) {
        include(0.45, (length - 1.1) / 2 - 0.1, width / 2 - 0.045)
      }
      if (height < base + 0.45) {
        include(0.45 - (length - 1.1) / 2 - 0.5, 0.5, 0.05)
      }
      if (height < base + 0.35) {
        include(-length / 2 + 0.1, 0.1, 0.25)
      }
      if (!Number.isFinite(a0)) {
        return null
      }
      return alongX
        ? { x: c.x + c.w / 2 + a0, z: c.z + c.d / 2 + b0, w: a1 - a0, d: b1 - b0 }
        : { x: c.x + c.w / 2 + b0, z: c.z + c.d / 2 + a0, w: b1 - b0, d: a1 - a0 }
    },
    heightAt: (x, z) => {
      const a = (alongX ? x - c.x - c.w / 2 : z - c.z - c.d / 2) - 0.45
      const b = alongX ? z - c.z - c.d / 2 : x - c.x - c.w / 2
      const aa = Math.abs(a)
      const bb = Math.abs(b)
      let y = wagonHardwareTop(a, b, size)
      if (aa <= canvasLength / 2 && bb <= radius) {
        const u = Math.min(CANOPY_SPANS - 1e-9, (a / canvasLength + 0.5) * CANOPY_SPANS)
        const j = Math.max(0, Math.floor(u))
        let lo = 0
        let hi = CANOPY_SEGMENTS
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1
          if ((across[mid] ?? 0) >= b) {
            lo = mid
          } else {
            hi = mid
          }
        }
        const v = ((across[lo] ?? 0) - b) / ((across[lo] ?? 0) - (across[lo + 1] ?? 0))
        const row = j * (CANOPY_SEGMENTS + 1) + lo
        y = Math.max(y, panelHeight(heights, row, u - j, v))
      }
      return y
    },
  }
}

function wellShape(c: Cover): ShapedCover {
  const base = c.y0 ?? 0
  const size = Math.min(c.w, c.d) - 0.1
  const half = (size - 0.1) / 2
  return {
    ...c,
    slopeAt: (x, z) => Math.abs(x - c.x - c.w / 2) <= half && Math.abs(z - c.z - c.d / 2) <= half,
    boundsAbove: (height) => {
      let hx = 0
      let hz = 0
      if (height < base + 0.87) {
        hx = size / 2 + 0.02
        hz = hx
      }
      if (height < base + WELL_EAVE + WELL_RISE) {
        hx = Math.max(hx, half)
        hz = Math.max(hz, half * Math.min(1, 1 - (height - base - WELL_EAVE) / WELL_RISE))
      }
      if (height < base + WELL_CAP) {
        hx = Math.max(hx, (size - 0.08) / 2)
        hz = Math.max(hz, 0.045)
      }
      return hx > 0 && hz > 0
        ? { x: c.x + c.w / 2 - hx, z: c.z + c.d / 2 - hz, w: hx * 2, d: hz * 2 }
        : null
    },
    heightAt: (x, z) => {
      const a = Math.abs(x - c.x - c.w / 2)
      const b = Math.abs(z - c.z - c.d / 2)
      let y = 0
      if (a <= size / 2 + 0.02 && b <= size / 2 + 0.02 && Math.max(a, b) >= size / 2 - 0.3) {
        y = base + 0.87
      }
      if (a <= half && b <= half) {
        y = base + WELL_EAVE + WELL_RISE * (1 - b / half)
      }
      if (a <= (size - 0.08) / 2 && b <= 0.045) {
        y = base + WELL_CAP
      }
      return y
    },
  }
}

export function shapedCover(c: Cover): ShapedCover | null {
  if (c.kind === 'covered_wagon') {
    return wagonShape(c)
  }
  return c.kind === 'well' ? wellShape(c) : null
}
