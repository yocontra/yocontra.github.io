import { describe, expect, it } from 'bun:test'
import { FEEL } from '../../src/experiments/out-west/data/feel.ts'
import {
  BOSS_PHASE2,
  TOUCH_ALLOWANCE_MS as CLIENT_TOUCH_MS,
  OUTLAWS,
  RIFLEMAN,
} from '../../src/experiments/out-west/data/outlaws.ts'
import { BOSS_LEVEL, LAST_LEVEL, TOUCH_ALLOWANCE_MS, tuningFor } from './tuning.ts'

describe('ranked tuning matches the client roster', () => {
  it('has one row per outlaw', () => {
    expect(OUTLAWS).toHaveLength(LAST_LEVEL + 1)
  })
  it('draw, jitter, accuracy, wait and fake chance agree outlaw by outlaw', () => {
    OUTLAWS.forEach((o, level) => {
      const t = tuningFor(level)
      if (!t) {
        throw new Error(`no tuning for level ${level}`)
      }
      expect(t.fakeChance).toBe(o.fakeChance)
      // the boss's clock sets his wait, not the table
      const wait: readonly [number, number] =
        o.gimmick === 'boss' ? [0, 0] : [o.wait[0] * 1000, o.wait[1] * 1000]
      expect(t.waitMs).toEqual(wait)
      // the server's first target is the rooftop rifleman on the underboss
      const main = o.gimmick === 'underboss' ? t.targets[1] : t.targets[0]
      // two guns: the first always misses, the second follows delmerGapMs later
      const draw = o.gimmick === 'two-guns' ? o.draw + FEEL.delmerGapMs : o.draw
      expect(main?.drawMs).toBe(draw)
      expect(main?.jitterMs).toBe(o.jitter)
      expect(main?.accuracy).toBe(o.accuracy)
    })
  })
  it('the boss’s second phase agrees', () => {
    const t = tuningFor(BOSS_LEVEL, 2)?.targets[0]
    expect(t?.drawMs).toBe(BOSS_PHASE2.draw)
    expect(t?.jitterMs).toBe(BOSS_PHASE2.jitter)
  })
  it('the touch allowance agrees and slows every target by it', () => {
    expect(TOUCH_ALLOWANCE_MS).toBe(CLIENT_TOUCH_MS)
    for (let level = 0; level <= LAST_LEVEL; level++) {
      const keys = tuningFor(level)?.targets ?? []
      const touch = tuningFor(level, 1, true)?.targets ?? []
      expect(touch.map((x) => x.drawMs)).toEqual(keys.map((x) => x.drawMs + TOUCH_ALLOWANCE_MS))
    }
  })
  it('the underboss rifleman agrees', () => {
    const t = tuningFor(15)?.targets[0]
    expect(t?.drawMs).toBe(RIFLEMAN.draw)
    expect(t?.jitterMs).toBe(RIFLEMAN.jitter)
    expect(t?.accuracy).toBe(RIFLEMAN.accuracy)
  })
})
