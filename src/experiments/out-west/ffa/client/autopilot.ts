/**
 * Dev-only autopilot for automated multi-page tests (`?debug=…` on the dev page). It steers the
 * same input frames a player would send: walk a path (F's server-bot pathfinder over the client's
 * own collision grid), aim at a player or a point, and tap buttons. The server can't tell it from
 * a person with a very steady hand, so it exercises the real netcode end to end.
 */
import { buildNav, findPath, type NavGrid, nextWaypoint } from '../../../../../api/src/town/nav.ts'
import type { Grid } from '../sim/layout.ts'

export interface Steer {
  mx: number
  mz: number
  /** Radians, or null to leave the aim alone. */
  aim: number | null
  buttons: number
}

export class Autopilot {
  private nav: NavGrid | null = null
  private readonly grid: Grid
  private path: { x: number; z: number }[] = []
  private aimId = -1
  private aimPt: { x: number; z: number } | null = null
  private taps = 0
  private held = 0
  /** A constant stick (unit vector) while no path is set: straight-line walks for the motion trace. */
  private stickX = 0
  private stickZ = 0
  active = false

  constructor(grid: Grid) {
    this.grid = grid
  }

  go(fromX: number, fromZ: number, x: number, z: number): boolean {
    this.nav ??= buildNav(this.grid)
    const p = findPath(this.nav, { x: fromX, z: fromZ }, { x, z })
    this.path = p ?? []
    this.active = true
    return p !== null
  }

  stop(): void {
    this.path = []
  }

  get walking(): boolean {
    return this.path.length > 0
  }

  aimAt(id: number): void {
    this.aimId = id
    this.aimPt = null
    this.active = true
  }

  aimPoint(x: number, z: number): void {
    this.aimPt = { x, z }
    this.aimId = -1
    this.active = true
  }

  tap(bit: number): void {
    this.taps |= bit
    this.active = true
  }

  hold(bit: number, on: boolean): void {
    this.held = on ? this.held | bit : this.held & ~bit
    this.active = true
  }

  stick(mx: number, mz: number): void {
    this.stickX = mx
    this.stickZ = mz
    this.active = true
  }

  release(): void {
    this.stickX = 0
    this.stickZ = 0
    this.active = false
    this.path = []
    this.aimId = -1
    this.aimPt = null
    this.held = 0
  }

  steer(x: number, z: number, posOf: (id: number) => { x: number; z: number } | null): Steer {
    const next = nextWaypoint(this.grid, this.path, { x, z, arrivalSquared: 0.5 })
    let mx = this.stickX
    let mz = this.stickZ
    if (next) {
      const dx = next.x - x
      const dz = next.z - z
      const d = Math.hypot(dx, dz) || 1
      mx = dx / d
      mz = dz / d
    }
    let aim: number | null = null
    const t = this.aimId >= 0 ? posOf(this.aimId) : this.aimPt
    if (t) {
      aim = Math.atan2(t.z - z, t.x - x)
    }
    const buttons = this.held | this.taps
    this.taps = 0
    return { mx, mz, aim, buttons }
  }
}
