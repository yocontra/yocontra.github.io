/** Helpers for the Frontier sim tests: place players, build frames, run ticks. */
import { ANGLE_SCALE } from '../../../src/experiments/out-west/contract/town.ts'
import { createWorld, type World } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { InputFrame, Player } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { addPlayer, step } from '../../../src/experiments/out-west/ffa/sim/world.ts'

export function testWorld(seed = 7): World {
  const w = createWorld({ seed })
  // Keep strongboxes out of the way unless a test wants one.
  w.nextStrongboxTick = 1_000_000
  return w
}

export interface PlaceOptions {
  level?: number
  bot?: boolean
  carried?: number
  account?: string
}

/** Add a player standing at (x, z), unprotected and long past the pardon window. */
export function place(w: World, x: number, z: number, opts: PlaceOptions = {}): Player {
  const id = addPlayer(w, {
    accountId: opts.account ?? `acct-${w.players.filter(Boolean).length}`,
    name: 'Tester',
    level: opts.level ?? 10,
    prestige: 0,
    bot: opts.bot ?? false,
  })
  const p = w.players[id]
  if (!p) {
    throw new Error('lobby full')
  }
  p.x = x
  p.z = z
  p.protectUntil = 0
  p.spawnTick = -10_000
  p.carried = opts.carried ?? 0
  return p
}

/** Aim from a to b, in u16 turns. */
export function aimAt(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const rad = Math.atan2(b.z - a.z, b.x - a.x)
  const turns = rad / (Math.PI * 2)
  return Math.round((turns - Math.floor(turns)) * ANGLE_SCALE) % ANGLE_SCALE
}

export function frame(partial: Partial<InputFrame> = {}): InputFrame {
  return { seq: 0, moveX: 0, moveZ: 0, aim: 0, buttons: 0, viewTime: 0, ...partial }
}

/** Run `n` ticks with the given per-player frames (functions of the world tick). */
export function run(
  w: World,
  n: number,
  frames: Record<number, (tick: number) => Partial<InputFrame>> = {},
): void {
  for (let i = 0; i < n; i++) {
    const list: (InputFrame | null)[] = []
    for (const [id, f] of Object.entries(frames)) {
      list[Number(id)] = frame({ viewTime: w.tick - 1, ...f(w.tick) })
    }
    step(w, list)
  }
}

/** Collect events of one type across `n` ticks. */
export function runCollect(
  w: World,
  n: number,
  frames: Record<number, (tick: number) => Partial<InputFrame>>,
  type: string,
): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < n; i++) {
    run(w, 1, frames)
    out.push(...w.events.filter((e) => e.type === type))
  }
  return out
}
