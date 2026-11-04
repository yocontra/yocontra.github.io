import { describe, expect, it } from 'bun:test'
import type { InputFrame } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { spawnPlayer, step } from '../../../src/experiments/out-west/ffa/sim/world.ts'
import { BotDirector, botName, freshBotName } from './bots.ts'
import { place, testWorld } from './test-helpers.ts'

const DIGIT = /\d/u

describe('bot names', () => {
  it('64 distinct names with no numeric suffixes', () => {
    const names = Array.from({ length: 64 }, (_, n) => botName(n))
    expect(new Set(names).size).toBe(64)
    expect(names.filter((n) => DIGIT.test(n))).toEqual([])
  })

  it('a full town of 32 bots never repeats a name, whatever the seeds', () => {
    const inUse = new Set<string>()
    for (let i = 0; i < 32; i++) {
      inUse.add(freshBotName(7 * i, inUse))
    }
    expect(inUse.size).toBe(32)
  })
})

function tick(w: ReturnType<typeof testWorld>, director: BotDirector): void {
  const frames: (InputFrame | null)[] = []
  director.frames(w, frames)
  step(w, frames)
}

describe('bots in town', () => {
  it('two bots on the same spot back away from each other instead of locking up', () => {
    const w = testWorld()
    const a = place(w, 60, 61, { bot: true })
    const b = place(w, 60, 61, { bot: true })
    const director = new BotDirector(3)
    for (let i = 0; i < 20; i++) {
      tick(w, director)
    }
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.5)
  })

  it('a bot alone in town never stands about: at a goal it moves on within a few ticks', () => {
    const w = testWorld()
    const p = place(w, 60, 61, { bot: true })
    const director = new BotDirector(5)
    let still = 0
    let worst = 0
    let lastX = p.x
    let lastZ = p.z
    for (let i = 0; i < 20 * 60; i++) {
      tick(w, director)
      const moved = Math.hypot(p.x - lastX, p.z - lastZ) > 0.01
      still = moved || p.channel ? 0 : still + 1
      worst = Math.max(worst, still)
      lastX = p.x
      lastZ = p.z
    }
    expect(worst).toBeLessThan(20)
  })

  it('never spawns a rider on top of another while a clear spawn exists', () => {
    const w = testWorld()
    for (let i = 0; i < 31; i++) {
      place(w, 0, 0, { bot: true })
    }
    for (const p of w.players) {
      if (p) {
        spawnPlayer(w, p)
      }
    }
    const ps = w.players.filter((p) => p !== null)
    let closest = Number.POSITIVE_INFINITY
    for (const [i, p] of ps.entries()) {
      for (const q of ps.slice(i + 1)) {
        closest = Math.min(closest, Math.hypot(p.x - q.x, p.z - q.z))
      }
    }
    expect(closest).toBeGreaterThan(1)
  })
})
