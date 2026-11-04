import { describe, expect, test as it } from 'bun:test'
import { BTN_FIRE, BTN_JUMP, BTN_ROLL } from '../../../src/experiments/out-west/contract/town.ts'
import {
  HOP_TICKS,
  JUMP_COOLDOWN_TICKS,
  PLAYER_RADIUS,
  ROLL_COOLDOWN_TICKS,
  ROLL_DISTANCE,
  RUN_SPEED,
  TICK_HZ,
  VAULT_TICKS,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import {
  BLOCK_MOVE,
  buildGrid,
  circleBlocked,
  type Rect,
  TOWN,
} from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import {
  inIframes,
  quantize,
  stepMove,
  vaultDistance,
  vaulting,
} from '../../../src/experiments/out-west/ffa/sim/move.ts'
import type { MoveState } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { place, runCollect, testWorld } from './test-helpers.ts'

const grid = buildGrid()
const state = (x: number, z: number): MoveState => ({
  x,
  z,
  y: 0,
  roof: 0,
  climbTicks: 0,
  climbDeck: 0,
  climbDir: 0,
  fallTicks: 0,
  fallTotal: 0,
  fallFromX: 0,
  fallFromZ: 0,
  fallFromY: 0,
  fallToX: 0,
  fallToZ: 0,
  rollTicks: 0,
  rollCooldown: 0,
  rollDirX: 0,
  rollDirZ: 0,
  jumpTicks: 0,
  jumpCooldown: 0,
  vaultStep: 0,
  vaultAim: 0,
  sprinting: false,
  sprintLock: 0,
  sprintOut: 0,
  slideTicks: 0,
  slideCooldown: 0,
  slideAim: 0,
  airX: 0,
  airZ: 0,
})
const input = (moveX: number, moveZ: number, buttons = 0, prevButtons = 0) => ({
  moveX,
  moveZ,
  aim: 0,
  buttons,
  prevButtons,
  canMove: true,
})

describe('movement', () => {
  it('runs at 5.5 m/s on open ground', () => {
    const m = state(30, 64)
    for (let i = 0; i < TICK_HZ; i++) {
      stepMove(grid, m, input(127, 0))
    }
    expect(m.x - 30).toBeCloseTo(RUN_SPEED, 1)
  })

  it('a hacked stick magnitude is clamped (no speed hack)', () => {
    const honest = state(30, 64)
    const hacked = state(30, 64)
    stepMove(grid, honest, input(127, 127))
    stepMove(grid, hacked, input(127, 127))
    const step = Math.hypot(honest.x - 30, honest.z - 64)
    expect(step).toBeCloseTo(RUN_SPEED / TICK_HZ, 2)
    expect(hacked).toEqual(honest)
  })

  it('the dead zone ignores stick noise', () => {
    const m = state(30, 64)
    expect(stepMove(grid, m, input(10, -8))).toBe(false)
    expect(m.x).toBe(30)
  })

  it('walls stop you and you slide along them', () => {
    // Run east into the saloon's west wall (x = 47) at z = 40, pushing diagonally.
    const m = state(44, 40)
    for (let i = 0; i < 40; i++) {
      stepMove(grid, m, input(127, 40))
    }
    expect(m.x).toBeLessThanOrEqual(47 - 0.4 + 1e-6)
    expect(m.z).toBeGreaterThan(41)
  })

  it('no tunnelling through a 0.5 m wall at roll speed', () => {
    const m = state(45.5, 40)
    for (let i = 0; i < 10; i++) {
      stepMove(grid, m, input(127, 0, i === 0 ? BTN_ROLL : 0, i === 1 ? BTN_ROLL : 0))
    }
    expect(m.x).toBeLessThan(47)
  })

  it('positions are quantised to the codec grid', () => {
    const m = state(30, 64)
    stepMove(grid, m, input(90, 37))
    expect(m.x).toBe(quantize(m.x))
    expect(m.z).toBe(quantize(m.z))
  })

  it('roll: 4 m in 0.35 s, i-frames for 0.25 s, 2.5 s cooldown', () => {
    const m = state(20, 64)
    stepMove(grid, m, input(127, 0, BTN_ROLL, 0))
    let iframeTicks = inIframes(m) ? 1 : 0
    let ticks = 1
    while (m.rollTicks > 0) {
      stepMove(grid, m, input(0, 0, BTN_ROLL, BTN_ROLL))
      iframeTicks += inIframes(m) ? 1 : 0
      ticks++
    }
    expect(ticks).toBe(7)
    expect(iframeTicks).toBe(5)
    expect(m.x - 20).toBeCloseTo(ROLL_DISTANCE, 1)
    // Can't roll again until the cooldown ends.
    const x = m.x
    stepMove(grid, m, input(0, 0, BTN_ROLL, 0))
    expect(m.x).toBe(x)
    for (let i = 0; i < ROLL_COOLDOWN_TICKS; i++) {
      stepMove(grid, m, input(0, 0))
    }
    stepMove(grid, m, input(0, 0, BTN_ROLL, 0))
    expect(m.rollTicks).toBeGreaterThan(0)
  })

  it('roll without a stick goes where you aim', () => {
    const m = state(20, 64)
    stepMove(grid, m, { ...input(0, 0, BTN_ROLL, 0), aim: 16_384 })
    expect(m.rollDirZ).toBeCloseTo(1, 5)
  })
})

/** A vaultable piece with a clear run-up and landing across its thin side, and which way to go. */
interface Approach {
  from: MoveState
  moveX: number
  moveZ: number
  cover: Rect
}

const free = (m: MoveState): boolean =>
  !circleBlocked(grid, { x: m.x, z: m.z, r: PLAYER_RADIUS }, BLOCK_MOVE)

/** Both run-ups across a piece of cover's thin side. */
function approaches(c: Rect): Approach[] {
  const across = c.w < c.d
  const cx = c.x + c.w / 2
  const cz = c.z + c.d / 2
  const off = (across ? c.w : c.d) / 2 + PLAYER_RADIUS + 0.3
  return [1, -1].map((side) => ({
    from: state(across ? cx + side * off : cx, across ? cz : cz + side * off),
    moveX: across ? -side * 127 : 0,
    moveZ: across ? 0 : -side * 127,
    cover: c,
  }))
}

/** A vaultable piece with a clear run-up and landing across its thin side, and which way to go. */
function vaultSpot(kind: string): Approach {
  const spot = TOWN.cover
    .filter((c) => c.kind === kind && c.vaultHeight !== undefined)
    .flatMap(approaches)
    .find(
      (a) =>
        free(a.from) && vaultDistance(grid, a.from, Math.sign(a.moveX), Math.sign(a.moveZ)) > 0,
    )
  if (!spot) {
    throw new Error(`no clear ${kind} to vault`)
  }
  return spot
}

const jump = (mx: number, mz: number, pressed: boolean) =>
  input(mx, mz, pressed ? BTN_JUMP : 0, pressed ? 0 : BTN_JUMP)

describe('vault and hop (BTN_JUMP)', () => {
  it('vaults a fence: a committed 0.5 s arc to clear ground on the far side', () => {
    const { from, moveX, moveZ, cover } = vaultSpot('fence')
    const m = { ...from }
    stepMove(grid, m, jump(moveX, moveZ, true))
    expect(vaulting(m)).toBe(true)
    let ticks = 1
    while (vaulting(m)) {
      // the stick is ignored mid-vault: it's committed
      stepMove(grid, m, jump(-moveX, -moveZ, false))
      ticks++
    }
    expect(ticks).toBe(VAULT_TICKS)
    const beyond =
      moveX === 0
        ? Math.sign(moveZ) * (m.z - (cover.z + cover.d / 2))
        : Math.sign(moveX) * (m.x - (cover.x + cover.w / 2))
    expect(beyond).toBeGreaterThan(PLAYER_RADIUS)
    expect(circleBlocked(grid, { ...m, r: PLAYER_RADIUS }, BLOCK_MOVE)).toBe(false)
  })

  it('crates vault too; the same press on open ground is a hop that goes nowhere', () => {
    expect(vaultSpot('crates').cover.w).toBeGreaterThan(0)
    const m = state(20, 64)
    stepMove(grid, m, jump(0, 0, true))
    expect(m.jumpTicks).toBe(HOP_TICKS - 1)
    expect(m.vaultStep).toBe(0)
    expect(m.x).toBe(20)
    expect(m.z).toBe(64)
  })

  it('never vaults a wall or tall cover (the server runs this check itself)', () => {
    // the saloon's west wall at x = 47 (see "walls stop you")
    const wall = state(46.2, 40)
    expect(vaultDistance(grid, wall, 1, 0)).toBe(0)
    stepMove(grid, wall, jump(127, 0, true))
    expect(vaulting(wall)).toBe(false)
    for (let i = 0; i < 20; i++) {
      stepMove(grid, wall, jump(127, 0, false))
    }
    expect(wall.x).toBeLessThanOrEqual(47 - PLAYER_RADIUS + 1e-6)
    const tall = TOWN.cover
      .filter((q) => q.vaultHeight === undefined)
      .flatMap(approaches)
      .filter((a) => free(a.from))
    expect(tall.length).toBeGreaterThan(3)
    const vaulted = tall.filter(
      (a) => vaultDistance(grid, a.from, Math.sign(a.moveX), Math.sign(a.moveZ)) > 0,
    )
    expect(vaulted).toEqual([])
  })

  it('has a cooldown, and no roll or second jump mid-vault', () => {
    const { from, moveX, moveZ } = vaultSpot('fence')
    const m = { ...from }
    stepMove(grid, m, jump(moveX, moveZ, true))
    stepMove(grid, m, input(moveX, moveZ, BTN_ROLL, 0))
    expect(m.rollTicks).toBe(0)
    while (vaulting(m)) {
      stepMove(grid, m, input(0, 0))
    }
    stepMove(grid, m, jump(0, 0, true))
    expect(m.jumpTicks).toBe(0)
    for (let i = 0; i < JUMP_COOLDOWN_TICKS; i++) {
      stepMove(grid, m, input(0, 0))
    }
    stepMove(grid, m, jump(0, 0, true))
    expect(m.jumpTicks).toBeGreaterThan(0)
  })

  it('the lobby applies it from input frames: fence yes, saloon wall no, no shots mid-vault', () => {
    const w = testWorld()
    const spot = vaultSpot('fence')
    const a = place(w, spot.from.x, spot.from.z)
    const b = place(w, 46.2, 40)
    const shots = runCollect(
      w,
      VAULT_TICKS + 2,
      {
        [a.id]: (t) => ({
          moveX: spot.moveX,
          moveZ: spot.moveZ,
          buttons: (t === 0 ? BTN_JUMP : 0) | (t === 3 ? BTN_FIRE : 0),
        }),
        [b.id]: (t) => ({ moveX: 127, buttons: t === 0 ? BTN_JUMP : 0 }),
      },
      'shot',
    )
    expect(Math.hypot(a.x - spot.from.x, a.z - spot.from.z)).toBeGreaterThan(1)
    expect(circleBlocked(w.grid, { x: a.x, z: a.z, r: PLAYER_RADIUS }, BLOCK_MOVE)).toBe(false)
    expect(b.x).toBeLessThanOrEqual(47 - PLAYER_RADIUS + 1e-6)
    expect(shots).toEqual([])
  })

  it('replays exactly from the wire (u16 direction, centimetre step)', () => {
    const { from, moveX, moveZ } = vaultSpot('fence')
    const a = { ...from }
    stepMove(grid, a, jump(moveX, moveZ, true))
    const b: MoveState = { ...a, vaultStep: Math.round(a.vaultStep * 100) / 100 }
    while (vaulting(a)) {
      stepMove(grid, a, input(0, 0))
      stepMove(grid, b, input(0, 0))
      expect(b).toEqual(a)
    }
  })
})
