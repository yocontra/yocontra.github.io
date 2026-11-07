/** Frozen pre-optimization provider: coarse eight-metre bins and original evaluation order. */
import type { Vector3 } from 'three'
import type { CorpseGround } from '../../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { facadeSolids } from '../../src/experiments/out-west/ffa/scene/facade-profile.ts'
import {
  type Grid,
  type Surface,
  TOWN,
  type TownLayout,
} from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { surfaceTop } from '../../src/experiments/out-west/ffa/sim/surfaces.ts'

const tileKey = (x: number, z: number) => (Math.floor(x / 8) << 16) ^ (Math.floor(z / 8) & 0xff_ff)
const inside = (surface: Surface, x: number, z: number) =>
  x >= surface.x && x <= surface.x + surface.w && z >= surface.z && z <= surface.z + surface.d

interface ClothSurface extends Surface {
  pane?: number
}
const EMPTY: readonly ClothSurface[] = []
const DIRECTIONS = [
  { axis: 0, sign: 1, x: 1, y: 0, z: 0 },
  { axis: 0, sign: -1, x: -1, y: 0, z: 0 },
  { axis: 1, sign: 1, x: 0, y: 1, z: 0 },
  { axis: 1, sign: -1, x: 0, y: -1, z: 0 },
  { axis: 2, sign: 1, x: 0, y: 0, z: 1 },
  { axis: 2, sign: -1, x: 0, y: 0, z: -1 },
] as const
const paneSurfaces = (grid: Grid): ClothSurface[] =>
  grid.glass.map((pane) => ({
    x: pane.axis === 0 ? pane.at - 0.015 : pane.a0,
    z: pane.axis === 0 ? pane.a0 : pane.at - 0.015,
    w: pane.axis === 0 ? 0.03 : pane.a1 - pane.a0,
    d: pane.axis === 0 ? pane.a1 - pane.a0 : 0.03,
    bottom: pane.y0,
    top: pane.y1,
    kind: 'solid',
    pane: pane.index,
  }))

export function referenceClothGround(
  grid: Grid,
  layout: TownLayout = TOWN,
  broken: ReadonlySet<number> = new Set(),
): CorpseGround {
  const bins = new Map<number, ClothSurface[]>()
  for (const surface of [
    ...grid.decks,
    ...grid.stairs,
    ...grid.overheads,
    ...grid.roofs,
    ...facadeSolids(layout),
    ...paneSurfaces(grid),
  ]) {
    for (let z = Math.floor(surface.z / 8); z <= Math.floor((surface.z + surface.d) / 8); z++) {
      for (let x = Math.floor(surface.x / 8); x <= Math.floor((surface.x + surface.w) / 8); x++) {
        const key = (x << 16) ^ (z & 0xff_ff)
        const list = bins.get(key) ?? []
        list.push(surface)
        bins.set(key, list)
      }
    }
  }
  const spans = (x: number, z: number) => bins.get(tileKey(x, z)) ?? EMPTY
  const inBase = (x: number, y: number, z: number) => {
    const col = Math.floor(x / grid.cell)
    const row = Math.floor(z / grid.cell)
    if (col < 0 || row < 0 || col >= grid.n || row >= grid.n || y < 0) {
      return false
    }
    const index = row * grid.n + col
    if (y > (grid.tops[index] ?? 0)) {
      return false
    }
    const end = grid.holeStarts[index + 1] ?? 0
    for (let i = grid.holeStarts[index] ?? 0; i < end; i++) {
      const hole = grid.windowHoles[grid.holeRefs[i] ?? -1]
      if (
        hole &&
        x >= hole.x &&
        x <= hole.x + hole.w &&
        z >= hole.z &&
        z <= hole.z + hole.d &&
        y > hole.y0 &&
        y < hole.y1
      ) {
        return false
      }
    }
    return (grid.tops[index] ?? 0) > 0
  }
  const solid = (x: number, y: number, z: number) => {
    if (inBase(x, y, z)) {
      return true
    }
    for (const surface of spans(x, z)) {
      if (
        (surface.pane === undefined || !broken.has(surface.pane)) &&
        inside(surface, x, z) &&
        y >= surface.bottom &&
        y <= surfaceTop(surface, x, z)
      ) {
        return true
      }
    }
    return false
  }
  const height = (x: number, y: number, z: number) => {
    let top = 0
    const col = Math.floor(x / grid.cell)
    const row = Math.floor(z / grid.cell)
    const index = col >= 0 && row >= 0 && col < grid.n && row < grid.n ? row * grid.n + col : -1
    const base = grid.tops[index] ?? 0
    if (base <= y + 0.35) {
      top = Math.max(top, base)
    }
    for (const shape of grid.shapeCells[index] ?? []) {
      const value = shape.heightAt(x, z)
      // The canopy and well gable are thin shells, with empty space beneath them. Their
      // gameplay support profile is filled downward; loose cloth must stay on its own side.
      const fromAbove = !shape.slopeAt(x, z) || value <= y
      if (fromAbove && value <= y + 0.35 && value > top) {
        top = value
      }
    }
    for (const surface of spans(x, z)) {
      if (surface.pane !== undefined) {
        continue
      }
      const value = surfaceTop(surface, x, z)
      if (inside(surface, x, z) && surface.bottom <= y && value <= y + 0.35 && value > top) {
        top = value
      }
    }
    return top
  }
  return (x, y, z, correction) => {
    correction?.set(0, 0, 0)
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
      return 0
    }
    if (correction && solid(x, y, z)) {
      resolve({ x, y, z }, correction, solid)
    }
    const projectedX = x + (correction?.x ?? 0)
    const projectedZ = z + (correction?.z ?? 0)
    // Raised-prism penetration is already resolved along its nearest face, including an
    // underside. Do not add a second upward lift through an indoor ceiling.
    if (correction && correction.y !== 0) {
      return 0
    }
    return height(projectedX, y, projectedZ)
  }
}

function resolve(
  point: { x: number; y: number; z: number },
  out: Vector3,
  solid: (x: number, y: number, z: number) => boolean,
): void {
  const { x, y, z } = point
  let best = 0.55
  for (const direction of DIRECTIONS) {
    const { axis, sign, x: dx, y: dy, z: dz } = direction
    let free = 0.04
    while (free < best && solid(x + dx * free, y + dy * free, z + dz * free)) {
      free += 0.04
    }
    if (
      free > best ||
      y + dy * free < 0.008 ||
      solid(x + dx * free, y + dy * free, z + dz * free)
    ) {
      continue
    }
    let lower = Math.max(0, free - 0.04)
    let upper = free
    for (let i = 0; i < 7; i++) {
      const mid = (lower + upper) / 2
      if (solid(x + dx * mid, y + dy * mid, z + dz * mid)) {
        lower = mid
      } else {
        upper = mid
      }
    }
    best = upper
    out.set(0, 0, 0).setComponent(axis, sign * (upper + 0.008))
  }
  out.clampLength(0, 0.55)
}
