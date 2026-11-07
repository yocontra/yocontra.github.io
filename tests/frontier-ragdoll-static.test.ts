import { afterAll, describe, expect, it } from 'bun:test'
import { Body, Sphere, Vec3 } from 'cannon-es'
import { Group, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { falseFrontProfile } from '../src/experiments/out-west/ffa/scene/facade-profile.ts'
import { corpseGround } from '../src/experiments/out-west/ffa/scene/ragdoll-cloth-contact.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { frontOf } from '../src/experiments/out-west/ffa/sim/porches.ts'
import { surfaceTop, topAt } from '../src/experiments/out-west/ffa/sim/surfaces.ts'

const props = await new GLTFLoader().parseAsync(
  JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
  '',
)
const grid = buildGrid()
const pool = new Ragdolls({
  root: new Group(),
  grid,
  props,
  source: {
    captureCorpse: () => Promise.resolve(null),
    suppressCorpse: () => false,
    releaseCorpse: () => undefined,
  },
})
pool.world.gravity.set(0, 0, 0)
afterAll(() => pool.dispose())

function probeAt(point: Vec3, radius: number, step: number) {
  const body = new Body({
    mass: 1,
    shape: new Sphere(radius),
    position: point,
    collisionFilterGroup: 2,
    collisionFilterMask: 3,
  })
  pool.world.addBody(body)
  pool.world.step(step)
  const contacts = pool.world.contacts
    .filter((contact) => contact.bi === body || contact.bj === body)
    .map((contact) => {
      const other = contact.bi === body ? contact.bj : contact.bi
      const offset = contact.bi === body ? contact.rj : contact.ri
      return other.position.vadd(offset)
    })
  pool.world.removeBody(body)
  return { body, contacts }
}

describe.each([60, 120])('physical corpse contact with the actual town at %dHz', (frequency) => {
  const probe = (point: Vec3, radius = 0.08) => probeAt(point, radius, 1 / frequency)
  it('stops the real skin at the visible false-front wall above the gameplay wall', () => {
    const building = TOWN.buildings.find((item) => item.kind === 'saloon')
    if (!building) {
      throw new Error('Missing saloon fixture')
    }
    const front = frontOf(building, TOWN)
    const profile = falseFrontProfile(building, front)
    const p = profile.at(profile.len / 2, -0.12)
    const hit = probe(new Vec3(p.x, building.height + 0.7, p.z))
    const inward = new Vec3()
    if (front === 'n') {
      inward.z = 1
    } else if (front === 's') {
      inward.z = -1
    } else if (front === 'e') {
      inward.x = -1
    } else {
      inward.x = 1
    }
    expect(hit.contacts.length).toBeGreaterThan(0)
    expect(hit.body.velocity.dot(inward)).toBeGreaterThan(0)
  })
  it('supports street contacts and keeps an exposed wall solid at the shared grid boundary', () => {
    const floor = probe(new Vec3(72, 0.06, 69))
    expect(floor.contacts.some((point) => Math.abs(point.y) < 1e-5)).toBe(true)
    expect(floor.body.velocity.y).toBeGreaterThan(0)
    let wall: { x: number; z: number } | undefined
    for (let row = 1; row < grid.n - 1 && !wall; row++) {
      for (let col = 1; col < grid.n - 1; col++) {
        if ((grid.tops[row * grid.n + col] ?? 0) > 3 && grid.tops[row * grid.n + col - 1] === 0) {
          wall = { x: col * grid.cell, z: (row + 0.5) * grid.cell }
          break
        }
      }
    }
    if (!wall) {
      throw new Error('Missing exposed wall fixture')
    }
    const hit = probe(new Vec3(wall.x - 0.06, 0.3, wall.z))
    expect(hit.contacts.some((point) => Math.abs(point.x - wall.x) < 1e-5)).toBe(true)
    expect(hit.body.velocity.x).toBeLessThan(0)
  })

  it('matches the true pitched roof and stair ramp, rather than a flat bounding cap', () => {
    const roof = grid.roofs[0]
    const stair = grid.stairs[0]
    if (!(roof && stair)) {
      throw new Error('Missing elevated surface fixtures')
    }
    for (const surface of [roof, stair]) {
      const x = surface.x + surface.w * 0.37
      const z = surface.z + surface.d * 0.41
      const top = surfaceTop(surface, x, z)
      const hit = probe(new Vec3(x, top + 0.06, z))
      expect(
        hit.contacts.some(
          (point) => Math.abs(point.y - surfaceTop(surface, point.x, point.z)) < 0.015,
        ),
      ).toBe(true)
      expect(hit.body.velocity.y).toBeGreaterThan(0)
    }
  })

  it('retains both the top and underside of an elevated thin slab', () => {
    const slab = grid.overheads.find(
      (surface) => !surface.heightAt && surface.w > 2 && surface.d > 1,
    )
    if (!slab) {
      throw new Error('Missing overhead fixture')
    }
    const x = slab.x + slab.w / 2
    const z = slab.z + slab.d / 2
    const upper = probe(new Vec3(x, slab.top + 0.06, z))
    const lower = probe(new Vec3(x, slab.bottom - 0.06, z))
    expect(upper.contacts.some((point) => Math.abs(point.y - slab.top) < 1e-5)).toBe(true)
    expect(lower.contacts.some((point) => Math.abs(point.y - slab.bottom) < 1e-5)).toBe(true)
    expect(upper.body.velocity.y).toBeGreaterThan(0)
    expect(lower.body.velocity.y).toBeLessThan(0)
  })

  it.each(['well', 'covered_wagon'] as const)('matches off-centre authored %s contact', (kind) => {
    const cover = TOWN.cover.find((item) => item.kind === kind)
    if (!cover) {
      throw new Error('Missing shaped cover fixture')
    }
    const alongX = cover.w >= cover.d
    let dx = alongX ? 0.45 : 0.35
    let dz = alongX ? 0.35 : 0.45
    if (kind === 'well') {
      dx = -0.3
      dz = 0.3
    }
    const x = cover.x + cover.w / 2 + dx
    const z = cover.z + cover.d / 2 + dz
    const top = topAt(grid, x, z)
    const hit = probe(new Vec3(x, top + 0.06, z))
    expect(
      hit.contacts.some((point) => Math.abs(point.y - topAt(grid, point.x, point.z)) < 0.02),
    ).toBe(true)
    expect(hit.body.velocity.y).toBeGreaterThan(0)
  })

  it('blocks intact glass and opens the real wall aperture only after authoritative shatter', () => {
    const pane = grid.glass.find((glass) =>
      grid.windowHoles.some((hole) => {
        const x = glass.axis === 0 ? glass.at : (glass.a0 + glass.a1) / 2
        const z = glass.axis === 0 ? (glass.a0 + glass.a1) / 2 : glass.at
        return x >= hole.x && x <= hole.x + hole.w && z >= hole.z && z <= hole.z + hole.d
      }),
    )
    if (!pane) {
      throw new Error('Missing hollow window fixture')
    }
    const mid = (pane.a0 + pane.a1) / 2
    const y = (pane.y0 + pane.y1) / 2
    const point =
      pane.axis === 0 ? new Vec3(pane.at + 0.06, y, mid) : new Vec3(mid, y, pane.at + 0.06)
    const intact = probe(point)
    expect(intact.contacts.length).toBeGreaterThan(0)
    pool.breakWindow(pane.index)
    try {
      expect(probe(point).contacts).toHaveLength(0)
    } finally {
      pool.setBrokenWindows(new Set())
    }
  })
})

it('conforms garment vertices against walls and both faces of elevated slabs without a ceiling pop', () => {
  const layout = { ...TOWN, buildings: [], cover: [], catwalks: [] }
  const local = buildGrid(layout)
  local.tops.fill(0)
  local.tops[10 * local.n + 10] = 2
  local.glass = []
  local.decks = []
  local.stairs = []
  local.overheads = [{ x: 4, z: 4, w: 2, d: 2, bottom: 3, top: 3.2, kind: 'overhead' }]
  const ground = corpseGround(local, layout)
  const delta = new Vector3()
  expect(ground(5.1, 1, 5.25, delta)).toBe(0)
  expect(delta.x).toBeCloseTo(-0.108, 3)
  expect(delta.y).toBe(0)
  ground(5, 3.15, 5, delta)
  expect(delta.y).toBeCloseTo(0.058, 3)
  ground(5, 3.05, 5, delta)
  expect(delta.y).toBeCloseTo(-0.058, 3)
  expect(ground(5, 2.98, 5, delta)).toBe(2)
  expect(delta.length()).toBe(0)
  expect(ground(5, 3.3, 5, delta)).toBe(3.2)
  expect(delta.length()).toBe(0)
})

it.each(['well', 'covered_wagon'] as const)(
  'keeps cloth below the open %s roof shell while supporting it from above',
  (kind) => {
    const cover = TOWN.cover.find((item) => item.kind === kind)
    if (!cover) {
      throw new Error('Missing actual shaped cover')
    }
    const x = cover.x + cover.w / 2 + 0.2
    const z = cover.z + cover.d / 2 + 0.2
    const top = topAt(grid, x, z)
    const ground = corpseGround(grid)
    const delta = new Vector3()
    expect(ground(x, top - 0.25, z, delta)).toBeLessThanOrEqual(top - 0.25)
    expect(delta.length()).toBe(0)
    expect(ground(x, top + 0.02, z, delta)).toBeCloseTo(top, 6)
    expect(delta.length()).toBe(0)
  },
)
