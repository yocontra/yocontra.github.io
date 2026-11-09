import { expect, it } from 'bun:test'
import { Autopilot } from '../../../src/experiments/out-west/ffa/client/autopilot.ts'
import { PLAYER_RADIUS } from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  buildGrid,
  circleBlocked,
  TOWN,
} from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { radiansToAim } from '../../../src/experiments/out-west/ffa/sim/move.ts'
import { blockedAt } from '../../../src/experiments/out-west/ffa/sim/surfaces.ts'
import type { InputFrame } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { step } from '../../../src/experiments/out-west/ffa/sim/world.ts'
import { BotDirector } from './bots.ts'
import { buildNav, findPath, type NavGrid, nextWaypoint } from './nav.ts'
import { HANDS, PracticePilot } from './practice-bench.ts'
import { place } from './test-helpers.ts'
import { nativeTestWorld } from './testing/native.ts'

interface Point {
  x: number
  z: number
}
const FROM = TOWN.spawns.find((spawn) => spawn.x === 88 && spawn.z === 80)
if (!FROM) {
  throw new Error('Missing water-tower lane spawn')
}
const BANK = TOWN.zones.find((zone) => zone.id === 'bank_w1')
if (!BANK) {
  throw new Error('Missing authored bank counter')
}

function maze(rows: string[]): NavGrid {
  const n = rows.length
  return {
    n,
    free: new Uint8Array(rows.flatMap((row) => [...row].map((cell) => Number(cell === '.')))),
  }
}
function blockedSegments(path: Point[], from: Point, blocked: (point: Point) => boolean): Point[] {
  let previous = from
  const hits: Point[] = []
  for (const next of path) {
    const samples = Math.max(
      1,
      Math.ceil(Math.hypot(next.x - previous.x, next.z - previous.z) * 40),
    )
    for (let i = 0; i <= samples; i++) {
      const p = {
        x: previous.x + ((next.x - previous.x) * i) / samples,
        z: previous.z + ((next.z - previous.z) * i) / samples,
      }
      if (blocked(p)) {
        hits.push(p)
        break
      }
    }
    previous = next
  }
  return hits
}

it('keeps the real water-tower to bank route clear for the actual player capsule', () => {
  const grid = buildGrid()
  const path = findPath(buildNav(grid), FROM, BANK)
  if (!path) {
    throw new Error('The reachable bank has no path')
  }
  expect(path.at(-1)).toEqual({ x: BANK.x, z: BANK.z })
  expect(
    blockedSegments(
      path,
      FROM,
      (p) =>
        circleBlocked(grid, { ...p, r: PLAYER_RADIUS }, BLOCK_MOVE) ||
        blockedAt(grid, p.x, p.z, PLAYER_RADIUS, 0),
    ),
  ).toEqual([])
})

it('excludes bank-stair waypoints that have clear 2D cells but insufficient capsule headroom', () => {
  const grid = buildGrid()
  expect(circleBlocked(grid, { x: 38.5, z: 73.5, r: PLAYER_RADIUS }, BLOCK_MOVE)).toBe(false)
  expect(blockedAt(grid, 38.5, 73.5, PLAYER_RADIUS, 0)).toBe(true)
  const nav = buildNav(grid)
  expect(nav.free[73 * nav.n + 38]).toBe(0)
})

it('retains a nearby corner until the following actual-capsule leg is clear', () => {
  const grid = buildGrid({
    ...TOWN,
    size: 8,
    creek: { ...TOWN.creek, z: 0, banks: [] },
    buildings: [],
    catwalks: [],
    cover: [{ kind: 'crates', low: false, x: 3, z: 3, w: 1, d: 1, top: 2 }],
  })
  const corner = { x: 2.5, z: 2.5 }
  const after = { x: 2.5, z: 4.5 }
  const path = [corner, after]
  expect(nextWaypoint(grid, path, { x: 3.1, z: 2.5 })).toBe(corner)
  expect(path).toHaveLength(2)
  expect(nextWaypoint(grid, path, corner)).toBe(after)
  expect(path).toEqual([after])
})

it('preserves every maze turn and the final goal while keeping short straight-road waypoints', () => {
  const nav = maze(['#######', '#.....#', '####..#', '#.....#', '#.#####', '#.....#', '#######'])
  const from = { x: 1.5, z: 1.5 }
  const goal = { x: 5.5, z: 5.5 }
  const path = findPath(nav, from, goal)
  if (!path) {
    throw new Error('The connected maze has no path')
  }
  expect(path.at(-1)).toEqual(goal)
  expect(
    blockedSegments(path, from, (p) => !nav.free[Math.floor(p.z) * nav.n + Math.floor(p.x)]),
  ).toEqual([])
  let previous = from
  for (const point of path) {
    expect(
      Math.max(Math.abs(point.x - previous.x), Math.abs(point.z - previous.z)),
    ).toBeLessThanOrEqual(3)
    previous = point
  }
})

it('returns an empty path at the current goal and null across a disconnected wall', () => {
  const nav = maze(['#####', '#.#.#', '#.#.#', '#.#.#', '#####'])
  expect(findPath(nav, { x: 1.5, z: 1.5 }, { x: 1.5, z: 1.5 })).toEqual([])
  expect(findPath(nav, { x: 1.5, z: 1.5 }, { x: 3.5, z: 3.5 })).toBeNull()
})

it('preserves the original straight-road and diagonal three-cell waypoint cadence', () => {
  const nav = maze(Array.from({ length: 9 }, () => '.'.repeat(9)))
  expect(findPath(nav, { x: 1.5, z: 1.5 }, { x: 7.5, z: 1.5 })).toEqual([
    { x: 4.5, z: 1.5 },
    { x: 7.5, z: 1.5 },
  ])
  expect(findPath(nav, { x: 1.5, z: 1.5 }, { x: 7.5, z: 7.5 })).toEqual([
    { x: 4.5, z: 4.5 },
    { x: 7.5, z: 7.5 },
  ])
})

it('the actual autopilot reaches the bank through authoritative movement without a stuck corner', async () => {
  const world = await nativeTestWorld()
  const player = place(world, FROM.x, FROM.z)
  const pilot = new Autopilot(world.grid)
  expect(pilot.go(player.x, player.z, BANK.x, BANK.z)).toBe(true)
  let still = 0
  let longest = 0
  for (let tick = 0; tick < 80 * 20 && pilot.walking; tick++) {
    const intent = pilot.steer(player.x, player.z, () => null)
    const before = { x: player.x, z: player.z }
    const frames: (InputFrame | null)[] = []
    frames[player.id] = {
      moveX: Math.round(intent.mx * 127),
      moveZ: Math.round(intent.mz * 127),
      aim: radiansToAim(Math.atan2(intent.mz, intent.mx)),
      buttons: 0,
      seq: tick,
      viewTime: tick,
    }
    step(world, frames)
    still =
      pilot.walking && Math.hypot(player.x - before.x, player.z - before.z) < 0.005 ? still + 1 : 0
    longest = Math.max(longest, still)
  }
  expect(pilot.walking).toBe(false)
  expect(Math.hypot(player.x - BANK.x, player.z - BANK.z)).toBeLessThan(1.3)
  expect(longest).toBeLessThan(20)
})

it('the actual bot follower banks its carry on the route with its normal corner-arrival threshold', async () => {
  const bank = TOWN.zones.find((zone) => zone.id === 'bank_w1')
  if (!bank) {
    throw new Error('Missing bank fixture')
  }
  const world = await nativeTestWorld({ seed: 7, layout: { ...TOWN, zones: [bank] } })
  world.nextStrongboxTick = 1_000_000
  const player = place(world, FROM.x, FROM.z, { bot: true, carried: 1000 })
  const director = new BotDirector(3)
  for (let tick = 0; tick < 80 * 20 && player.stats.banked === 0; tick++) {
    const frames: (InputFrame | null)[] = []
    director.frames(world, frames)
    step(world, frames)
  }
  expect(player.stats.banked).toBeGreaterThan(0)
  expect(player.carried).toBe(0)
})

it('the actual practice pilot reaches and banks on the same route', async () => {
  const bank = TOWN.zones.find((zone) => zone.id === 'bank_w1')
  const hand = HANDS.reviewer
  if (!(bank && hand)) {
    throw new Error('Missing practice banking fixture')
  }
  const world = await nativeTestWorld({ seed: 7, layout: { ...TOWN, zones: [bank] } })
  world.nextStrongboxTick = 1_000_000
  const player = place(world, FROM.x, FROM.z, { carried: 1000 })
  const pilot = new PracticePilot(world, 3, hand)
  for (let tick = 0; tick < 80 * 20 && player.stats.banked === 0; tick++) {
    const frames: (InputFrame | null)[] = []
    frames[player.id] = { ...pilot.frame(world, player), seq: tick, viewTime: tick }
    step(world, frames)
  }
  expect(player.stats.banked).toBeGreaterThan(0)
  expect(player.carried).toBe(0)
})
