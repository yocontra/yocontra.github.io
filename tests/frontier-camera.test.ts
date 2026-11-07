import { describe, expect, it } from 'bun:test'
import { PerspectiveCamera, Vector3 } from 'three'
import {
  cameraClearance,
  ShooterCamera,
  type ShooterFrame,
} from '../src/experiments/out-west/ffa/client/shooter-camera.ts'
import { type VmInput, VmMotion } from '../src/experiments/out-west/ffa/client/vm-motion.ts'
import { buildGrid } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { rayWorld } from '../src/experiments/out-west/ffa/sim/surfaces.ts'

function emptyGrid() {
  const grid = buildGrid()
  grid.cells.fill(0)
  grid.tops.fill(0)
  grid.shapeCells.fill(undefined)
  grid.shaped = []
  grid.overheads = []
  grid.roofs = []
  grid.stairs = []
  grid.decks = []
  grid.windowHoles = []
  return grid
}

function lowWall(grid: ReturnType<typeof emptyGrid>) {
  for (let row = 16; row < 24; row++) {
    grid.tops[row * grid.n + 20] = 2
    grid.cells[row * grid.n + 20] = 255
  }
}

describe('height-aware camera clearance', () => {
  it('keeps the real saloon back-alley death camera outside a moving body and solid architecture', () => {
    const grid = buildGrid()
    const lens = new PerspectiveCamera(72, 1.6, 0.1, 200)
    lens.position.set(56.32, 0.59, 33.6)
    const camera = new ShooterCamera(lens)
    const focus = new Vector3(56.66, 1.94, 33.45)
    const frame: ShooterFrame = {
      x: 56.5,
      z: 34.1,
      feetY: 0,
      grounded: true,
      speed: 0,
      first: false,
      ads: false,
      fov: 72,
      shoulder: 1,
      far: 200,
      grid,
      dt: 1 / 60,
      duck: 0,
      dead: { x: 56.5, y: 0, z: 34.1 },
      corpseFocus: focus,
      corpseRadius: 1.2,
      killer: { x: 56.3, y: 0, z: 33.6 },
    }
    for (let step = 0; step < 240; step++) {
      focus.y = 1.94 - Math.min(1.4, step / 60)
      camera.update(frame)
      expect(lens.position.distanceTo(focus)).toBeGreaterThanOrEqual(1.6 - 1e-6)
      expect(
        rayWorld(grid, lens.position.x, lens.position.y, lens.position.z, 0, 1, 0, 0.01),
      ).toBeNull()
    }
  })

  it('passes over a wall below the lens while still blocking the same ground-level path', () => {
    const grid = emptyGrid()
    lowWall(grid)
    expect(cameraClearance(grid, 8, 5, 10, 12, 5, 10)).toBe(1)
    expect(cameraClearance(grid, 8, 1.5, 10, 12, 1.5, 10)).toBeLessThan(0.5)
  })

  it('catches an overhead slab and the upper edge of the lens', () => {
    const grid = emptyGrid()
    grid.overheads.push({ x: 9, z: 9, w: 2, d: 2, bottom: 2.8, top: 3, kind: 'overhead' })
    expect(cameraClearance(grid, 8, 1.5, 10, 12, 4, 10)).toBeLessThan(0.6)
    expect(cameraClearance(grid, 8, 2.65, 10, 12, 2.65, 10)).toBeLessThan(0.3)
    expect(cameraClearance(grid, 8, 2.65, 10, 12, 2.65, 10, 0)).toBe(1)
  })

  it('does not retract a rooftop gun against a wall underneath it', () => {
    const grid = emptyGrid()
    lowWall(grid)
    expect(cameraClearance(grid, 9.5, 5, 10, 10.7, 5, 10, 0.08, 0)).toBe(1)
    expect(cameraClearance(grid, 9.5, 1.5, 10, 10.7, 1.5, 10, 0.08, 0)).toBeLessThan(0.5)
  })

  it('keeps the death orbit and gaze with an elevated corpse', () => {
    const lens = new PerspectiveCamera(72, 1.6, 0.1, 200)
    lens.position.set(20, 6.62, 20)
    const camera = new ShooterCamera(lens)
    const frame: ShooterFrame = {
      x: 20,
      z: 20,
      feetY: 5,
      grounded: true,
      speed: 0,
      first: false,
      ads: false,
      fov: 72,
      shoulder: 1,
      far: 200,
      grid: emptyGrid(),
      dt: 1 / 60,
      duck: 0,
      dead: { x: 20, y: 5, z: 20 },
    }
    for (let i = 0; i < 120; i++) {
      camera.update(frame)
    }
    expect(lens.position.y).toBeGreaterThan(7)
    const towardBody = new Vector3(20, 5.4, 20).sub(lens.position).normalize()
    expect(lens.getWorldDirection(new Vector3()).dot(towardBody)).toBeCloseTo(1, 6)
  })

  it('follows a physical corpse off a roof while the authoritative death position stays unchanged', () => {
    const lens = new PerspectiveCamera(72, 1.6, 0.1, 200)
    lens.position.set(20, 9, 20)
    const camera = new ShooterCamera(lens)
    const focus = new Vector3(20, 8, 20)
    const frame: ShooterFrame = {
      x: 20,
      z: 20,
      feetY: 7,
      grounded: false,
      speed: 0,
      first: false,
      ads: false,
      fov: 72,
      shoulder: 1,
      far: 200,
      grid: emptyGrid(),
      dt: 1 / 60,
      duck: 0,
      dead: { x: 20, y: 7, z: 20 },
      corpseFocus: focus,
    }
    for (let i = 0; i < 240; i++) {
      const t = Math.min(1, i / 120)
      focus.set(20 + t * 6, 8 - t * 7.5, 20 + t * 2)
      camera.update(frame)
    }
    expect(frame.dead).toEqual({ x: 20, y: 7, z: 20 })
    expect(lens.position.y).toBeLessThan(5)
    expect(lens.position.x).toBeGreaterThan(22)
    expect(
      lens.getWorldDirection(new Vector3()).dot(focus.clone().sub(lens.position).normalize()),
    ).toBeCloseTo(1, 6)
  })
})

const move: VmInput = {
  dt: 1 / 60,
  lookYaw: 0,
  lookPitch: 0,
  speed: 4,
  sprinting: false,
  ads: false,
  crouched: false,
  sliding: false,
  grounded: true,
  reload: null,
  weapon: 0,
  wall: 2,
}

describe('supported view-model motion', () => {
  it('keeps a walking bob on support and suppresses it in the air', () => {
    const grounded = new VmMotion()
    const airborne = new VmMotion()
    let bob = 0
    let air = 0
    for (let i = 0; i < 180; i++) {
      const g = grounded.update(move)
      const a = airborne.update({ ...move, grounded: false })
      if (i > 120) {
        bob = Math.max(bob, Math.abs(g.x))
        air = Math.max(air, Math.abs(a.x))
      }
    }
    expect(bob).toBeGreaterThan(0.006)
    expect(air).toBeLessThan(0.0001)
  })

  it('adds a landing impulse on any support, independent of world elevation', () => {
    const landed = new VmMotion()
    const airborne = new VmMotion()
    for (let i = 0; i < 60; i++) {
      landed.update({ ...move, speed: 0, grounded: false })
      airborne.update({ ...move, speed: 0, grounded: false })
    }
    const impact = landed.update({ ...move, speed: 0 })
    const floating = airborne.update({ ...move, speed: 0, grounded: false })
    expect(impact.pitch).toBeGreaterThan(floating.pitch)
    expect(impact.y).toBeLessThan(floating.y)
  })
})
