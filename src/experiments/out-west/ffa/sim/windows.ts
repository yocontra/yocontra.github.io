/**
 * Breakable glass: a shot that crosses an intact pane shatters it and carries on. The pane never
 * stops a bullet or blocks sight, so this only flips state and queues the visual event.
 */
import type { World } from './state.ts'

/** Ignore a crossing closer than this to the muzzle, metres. */
const MIN_GLASS_CROSS = 0.05
/** A ray this close to parallel with a pane never hits it. */
const GLASS_PARALLEL = 1e-6

/** Shots and native capsule contacts share one authoritative state/event transition. */
export function breakGlass(w: World, index: number): void {
  if (w.glass[index] !== 0) {
    return
  }
  w.glass[index] = 1
  w.events.push({ type: 'glass_break', window: index })
}

/**
 * Shatter every intact pane whose plane this ray crosses before `maxDist`, emitting one
 * `glass_break` per pane. The caller's bullet trace continues unchanged.
 */
// biome-ignore lint/complexity/useMaxParams: a ray origin and direction are positional in the shot hot path
export function shatterGlass(
  w: World,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): void {
  for (const p of w.grid.glass) {
    if (w.glass[p.index] === 1) {
      continue
    }
    const d = p.axis === 0 ? dx : dz
    if (Math.abs(d) < GLASS_PARALLEL) {
      continue
    }
    const t = (p.at - (p.axis === 0 ? ox : oz)) / d
    if (t < MIN_GLASS_CROSS || t > maxDist) {
      continue
    }
    const across = p.axis === 0 ? oz + dz * t : ox + dx * t
    if (across < p.a0 || across > p.a1) {
      continue
    }
    const y = oy + dy * t
    if (y < p.y0 || y > p.y1) {
      continue
    }
    breakGlass(w, p.index)
  }
}
