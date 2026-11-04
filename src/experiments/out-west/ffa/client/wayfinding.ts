// biome-ignore-all lint/suspicious/noUnnecessaryConditions: marker state is mutated across frames; Biome narrows the fields to their initialisers
// biome-ignore-all lint/complexity/useMaxParams: per-frame marker update takes positional numbers
/**
 * The way to the bank while you carry money. A walking-distance field is flooded once over the
 * town's movement grid from every bank window, so the marker never points you into a wall: it sits
 * on the bank window when you can walk straight to it, otherwise on the furthest point down the
 * path you can walk to in a straight line (a door, a corner), eased so it glides rather than hops.
 * It reads "BANK" and the walking distance in metres, and pulses once you carry $300 or more
 * (the Most Wanted line). Off screen it rides the edge as a gold chevron. All views.
 *
 * The windows come from the layout (`bankWindows()`), so the arrow follows any re-layout.
 */
import type { PerspectiveCamera } from 'three'
import { MOST_WANTED_MIN } from '../sim/constants.ts'
import { BLOCK_MOVE, type Grid, rayGrid, TOWN, type TownLayout } from '../sim/layout.ts'
import { MinHeap } from './min-heap.ts'
import { type ScreenPoint, toScreen } from './screen.ts'

export interface BankWindow {
  id: string
  x: number
  z: number
}

/**
 * The bank windows. Today they are the layout's bank zones; `perdition-map` adds `BANK_WINDOWS`
 * to `sim/layout.ts`, at which point this becomes a re-export.
 */
export function bankWindows(layout: TownLayout = TOWN): BankWindow[] {
  return layout.zones.filter((z) => z.kind === 'bank').map((z) => ({ id: z.id, x: z.x, z: z.z }))
}

const INSET = 30
/** How far down the path (cells) to look for a straight-line waypoint. */
const LOOKAHEAD = 40
const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
]

/** Walking distance (m) from every cell to the nearest window, Infinity where unreachable. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one Dijkstra flood with its bounds and corner checks inline
export function flood(grid: Grid, targets: readonly BankWindow[]): Float32Array {
  const n = grid.n
  const dist = new Float32Array(n * n).fill(Number.POSITIVE_INFINITY)
  const heap = new MinHeap()
  for (const t of targets) {
    const c = Math.floor(t.x / grid.cell)
    const r = Math.floor(t.z / grid.cell)
    if (c >= 0 && r >= 0 && c < n && r < n) {
      dist[r * n + c] = 0
      heap.push(r * n + c, 0)
    }
  }
  while (heap.size > 0) {
    const [i, d] = heap.pop()
    if (d > (dist[i] ?? 0)) {
      continue
    }
    const c = i % n
    const r = (i - c) / n
    for (const [dc, dr, w] of NEIGHBOURS) {
      const cc = c + dc
      const rr = r + dr
      if (cc < 0 || rr < 0 || cc >= n || rr >= n) {
        continue
      }
      const j = rr * n + cc
      if ((grid.cells[j] ?? 0) & BLOCK_MOVE) {
        continue
      }
      // no cutting a wall's corner on a diagonal
      if (
        dc !== 0 &&
        dr !== 0 &&
        ((grid.cells[r * n + cc] ?? 0) & BLOCK_MOVE || (grid.cells[rr * n + c] ?? 0) & BLOCK_MOVE)
      ) {
        continue
      }
      const nd = d + w * grid.cell
      if (nd < (dist[j] ?? 0)) {
        dist[j] = nd
        heap.push(j, nd)
      }
    }
  }
  return dist
}

export class BankGuide {
  private readonly grid: Grid
  private readonly windows: BankWindow[]
  private field: Float32Array | null = null
  private readonly marker: HTMLElement
  private readonly label: HTMLElement
  private readonly dist: HTMLElement
  private readonly chevron: HTMLElement
  private readonly sp: ScreenPoint = { x: 0, y: 0, on: false, angle: 0 }
  /** The eased world point the marker sits on. */
  private readonly at = { x: 0, z: 0, has: false }
  private shown = false
  private lastText = ''
  /** Walking metres to the nearest window last frame (for the onboarding hint), or −1. */
  metres = -1

  constructor(parent: HTMLElement, grid: Grid, layout: TownLayout = TOWN) {
    this.grid = grid
    this.windows = bankWindows(layout)
    const layer = document.createElement('div')
    layer.className = 'fr-guide'
    this.marker = document.createElement('div')
    this.marker.className = 'fr-guide-mark'
    const pin = document.createElement('div')
    pin.className = 'fr-guide-pin'
    pin.textContent = '$'
    this.label = document.createElement('div')
    this.label.className = 'fr-guide-label'
    this.label.textContent = 'Bank'
    this.dist = document.createElement('div')
    this.dist.className = 'fr-guide-dist'
    this.marker.append(pin, this.label, this.dist)
    this.chevron = document.createElement('div')
    this.chevron.className = 'fr-guide-chevron'
    layer.append(this.marker, this.chevron)
    this.marker.hidden = true
    this.chevron.hidden = true
    parent.append(layer)
  }

  /** Flood the field (about 5 ms on a desktop; run once after the town is up). */
  prepare(): void {
    this.field ??= flood(this.grid, this.windows)
  }

  /** The nearest window by walking distance from (x, z), or null. */
  nearest(x: number, z: number): BankWindow | null {
    let best: BankWindow | null = null
    let bestD = Number.POSITIVE_INFINITY
    for (const w of this.windows) {
      const d = Math.hypot(w.x - x, w.z - z)
      if (d < bestD) {
        bestD = d
        best = w
      }
    }
    return best
  }

  /** Walking metres from (x, z) to the nearest window (straight-line if the field isn't ready). */
  walk(x: number, z: number): number {
    const f = this.field
    const g = this.grid
    const i = Math.floor(z / g.cell) * g.n + Math.floor(x / g.cell)
    const d = f?.[i]
    if (d !== undefined && Number.isFinite(d)) {
      return d
    }
    const w = this.nearest(x, z)
    return w ? Math.hypot(w.x - x, w.z - z) : -1
  }

  /** Where to walk next: the window if it's in a straight line, else the furthest such point down the path. */
  waypoint(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    const w = this.nearest(x, z)
    const f = this.field
    if (w && this.straight(x, z, w.x, w.z)) {
      out.x = w.x
      out.z = w.z
      return out
    }
    const g = this.grid
    const n = g.n
    let c = Math.floor(x / g.cell)
    let r = Math.floor(z / g.cell)
    out.x = w?.x ?? x
    out.z = w?.z ?? z
    if (!f) {
      return out
    }
    let best: { x: number; z: number } | null = null
    for (let step = 0; step < LOOKAHEAD; step++) {
      const here = f[r * n + c] ?? Number.POSITIVE_INFINITY
      if (here === 0) {
        break
      }
      let bc = c
      let br = r
      let bd = here
      for (const [dc, dr] of NEIGHBOURS) {
        const cc = c + dc
        const rr = r + dr
        const d = cc >= 0 && rr >= 0 && cc < n && rr < n ? (f[rr * n + cc] ?? bd) : bd
        if (d < bd) {
          bd = d
          bc = cc
          br = rr
        }
      }
      if (bc === c && br === r) {
        break
      }
      c = bc
      r = br
      const px = (c + 0.5) * g.cell
      const pz = (r + 0.5) * g.cell
      if (this.straight(x, z, px, pz)) {
        best = { x: px, z: pz }
      }
    }
    if (best) {
      out.x = best.x
      out.z = best.z
    }
    return out
  }

  private straight(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax
    const dz = bz - az
    const d = Math.hypot(dx, dz)
    if (d < 0.01) {
      return true
    }
    return (
      rayGrid(this.grid, { ox: ax, oz: az, dx: dx / d, dz: dz / d, maxDist: d }, BLOCK_MOVE) >= d
    )
  }

  private readonly wp = { x: 0, z: 0 }

  /**
   * Per frame. `carried` 0 (or dead) hides it. `inZone` (standing at a window) hides the marker:
   * the bank prompt takes over there.
   */
  update(
    cam: PerspectiveCamera,
    x: number,
    z: number,
    carried: number,
    alive: boolean,
    inZone: boolean,
    dt: number,
  ): void {
    const show = alive && carried > 0 && !inZone
    this.metres = alive && carried > 0 ? this.walk(x, z) : -1
    if (!show) {
      if (this.shown) {
        this.marker.hidden = true
        this.chevron.hidden = true
        this.shown = false
      }
      this.at.has = false
      return
    }
    this.shown = true
    const wp = this.waypoint(x, z, this.wp)
    if (this.at.has) {
      const k = 1 - Math.exp(-dt * 6)
      this.at.x += (wp.x - this.at.x) * k
      this.at.z += (wp.z - this.at.z) * k
    } else {
      this.at.x = wp.x
      this.at.z = wp.z
      this.at.has = true
    }
    const sp = toScreen(cam, this.at.x, 2.1, this.at.z, INSET, this.sp)
    const m = Math.max(0, Math.round(this.metres))
    const text = `${m} m`
    if (text !== this.lastText) {
      this.lastText = text
      this.dist.textContent = text
    }
    const big = carried >= MOST_WANTED_MIN
    this.marker.classList.toggle('big', big)
    this.chevron.classList.toggle('big', big)
    if (sp.on) {
      this.marker.hidden = false
      this.chevron.hidden = true
      this.marker.style.transform = `translate(${sp.x}px, ${sp.y}px)`
    } else {
      // off screen: the tag rides the edge with the chevron pointing on
      this.marker.hidden = false
      this.chevron.hidden = false
      const ix = sp.x - Math.cos(sp.angle) * 34
      const iy = sp.y - Math.sin(sp.angle) * 34
      this.marker.style.transform = `translate(${ix}px, ${iy}px)`
      this.chevron.style.transform = `translate(${sp.x}px, ${sp.y}px) rotate(${sp.angle}rad)`
    }
  }

  /** Dev and onboarding: the marker's state. */
  get state(): { shown: boolean; onScreen: boolean; metres: number } {
    return {
      shown: this.shown,
      onScreen: this.shown && this.chevron.hidden === true,
      metres: this.metres,
    }
  }
}
