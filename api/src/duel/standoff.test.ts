import { describe, expect, it } from 'bun:test'
import { tuningFor } from '../tuning.ts'
import { FakeClock, seeded } from './fake-clock.ts'
import type { Seat } from './judge-pvp.ts'
import {
  type AiOpponent,
  ghostChances,
  ghostOpponent,
  type HumanOpponent,
  outlawOpponent,
} from './opponents.ts'
import {
  CALL_LEAD_MS,
  fakeCount,
  MIN_CUE_GAP_MS,
  pvpWaitPlan,
  rankedWaitPlan,
  Standoff,
  type Verdict,
  type WaitPlan,
  type WaitStats,
} from './standoff.ts'

const human = (median = 0, jitter = 0, tcp: number | null = null): HumanOpponent => ({
  kind: 'human',
  link: () => ({ median, jitter, tcp }),
})

/** An AI that lands exactly where it is told. */
const fixedAi = (shots: number[], flinch = false, hazard = 0): AiOpponent => ({
  kind: 'ghost',
  flinches: () => flinch,
  hazardPerSecond: hazard,
  draw: () => shots,
})

function harness(
  mode: 'ranked' | 'pvp',
  seats: [HumanOpponent | AiOpponent, HumanOpponent | AiOpponent],
  plan: WaitPlan = { cues: [], callAtMs: 1000 },
) {
  const clock = new FakeClock()
  const log: string[] = []
  const calls: Seat[] = []
  let verdict: Verdict | null = null
  let stats: WaitStats | null = null
  const standoff = new Standoff({
    mode,
    seats,
    plan,
    clock,
    rng: seeded(7),
    events: {
      cue: (cue) => log.push(`cue:${cue}`),
      call: (seat) => calls.push(seat),
      end: (v, s) => {
        verdict = v
        stats = s
      },
    },
  })
  standoff.start()
  return {
    clock,
    log,
    calls,
    standoff,
    verdict: (): Verdict | null => verdict,
    stats: (): WaitStats | null => stats,
  }
}

describe('wait plans', () => {
  it('ranked plans follow the tuning table', () => {
    const rng = seeded(1)
    for (let level = 0; level <= 15; level++) {
      const tuning = tuningFor(level)
      if (!tuning) {
        throw new Error('missing tuning')
      }
      const plan = rankedWaitPlan(tuning, rng)
      expect(plan.callAtMs).toBeGreaterThanOrEqual(tuning.waitMs[0])
      expect(plan.callAtMs).toBeLessThanOrEqual(tuning.waitMs[1])
      expect(plan.cues.length).toBeLessThanOrEqual(1)
    }
  })
  it('the boss clock strikes six times before the call', () => {
    const boss = tuningFor(16)
    if (!boss) {
      throw new Error('missing tuning')
    }
    const plan = rankedWaitPlan(boss, seeded(3))
    expect(plan.cues.filter((c) => c.cue.startsWith('strike:'))).toHaveLength(6)
    expect(plan.callAtMs).toBeGreaterThan(6 * 1100)
  })
  it('pvp plans keep every cue 350 ms from the others, the start and the call', () => {
    const rng = seeded(11)
    for (let i = 0; i < 500; i++) {
      const plan = pvpWaitPlan(['crow', 'dog'], rng)
      expect(plan.callAtMs).toBeGreaterThanOrEqual(2000)
      expect(plan.callAtMs).toBeLessThanOrEqual(5000)
      const times = [0, ...plan.cues.map((c) => c.atMs), plan.callAtMs]
      for (let j = 1; j < times.length; j++) {
        expect((times[j] ?? 0) - (times[j - 1] ?? 0)).toBeGreaterThanOrEqual(MIN_CUE_GAP_MS - 1e-9)
      }
    }
  })
  it('fake-out counts follow 35/45/20', () => {
    const rng = seeded(5)
    const counts = [0, 0, 0]
    for (let i = 0; i < 20_000; i++) {
      const n = fakeCount(rng)
      counts[n] = (counts[n] ?? 0) + 1
    }
    expect((counts[0] ?? 0) / 20_000).toBeCloseTo(0.35, 1)
    expect((counts[1] ?? 0) / 20_000).toBeCloseTo(0.45, 1)
    expect((counts[2] ?? 0) / 20_000).toBeCloseTo(0.2, 1)
  })
})

describe('ranked standoff (the gauntlet, unchanged)', () => {
  it('a press before the call is cowardice', () => {
    const h = harness('ranked', [human(), fixedAi([500])])
    h.clock.advance(400)
    h.standoff.shot(0, null)
    expect(h.verdict()).toMatchObject({ kind: 'ranked', outcome: 'coward', reactionMs: -1 })
    expect(h.calls).toHaveLength(0)
  })

  it('a clean win reports the reaction and the outlaw time', () => {
    const h = harness('ranked', [human(), fixedAi([500])])
    h.clock.advance(1000)
    expect(h.calls).toEqual([0])
    h.clock.advance(240)
    h.standoff.shot(0, 240)
    expect(h.verdict()).toEqual({
      kind: 'ranked',
      outcome: 'win',
      reactionMs: 240,
      enemyMs: 500,
      targetsHit: 1,
    })
  })

  it('too slow is a loss once the outlaw lands (plus RTT and tolerance)', () => {
    const h = harness('ranked', [human(), fixedAi([500])])
    // Tolerance with no jitter is the 30 ms base.
    h.clock.advance(1000 + 500 + 30 + 50 - 1)
    expect(h.verdict()).toBeNull()
    h.clock.advance(2)
    expect(h.verdict()).toMatchObject({ outcome: 'loss', reactionMs: null, enemyMs: 500 })
  })

  it('anticipation under 100 ms counts as cowardice', () => {
    const h = harness('ranked', [human(), fixedAi([500])])
    h.clock.advance(1050)
    h.standoff.shot(0, 50)
    expect(h.verdict()).toMatchObject({ outcome: 'coward', reactionMs: -1 })
  })

  it('works with the real outlaw opponent', () => {
    const tuning = tuningFor(0)
    if (!tuning) {
      throw new Error('missing tuning')
    }
    const h = harness('ranked', [human(), outlawOpponent(tuning, seeded(2))])
    h.clock.advance(1000 + 300)
    h.standoff.shot(0, 300)
    expect(h.verdict()).toMatchObject({ outcome: 'win', reactionMs: 300 })
  })

  describe('the underboss (two targets)', () => {
    it('re-arms the loss timer to the outlaw still standing (bug a)', () => {
      // Rifleman lands at 330, Curly at 560. Kill the rifleman at 150 ms.
      const h = harness('ranked', [human(), fixedAi([330, 560])])
      h.clock.advance(1000 + 150)
      h.standoff.shot(0, 150, 0)
      // The old timer would have fired at 330 + 120 + 50 = 500 ms.
      h.clock.advance(400)
      expect(h.verdict()).toBeNull()
      h.standoff.shot(0, 540, 1)
      expect(h.verdict()).toMatchObject({ outcome: 'win', reactionMs: 150, targetsHit: 2 })
    })

    it('a stall after the first kill reports the shot and the live outlaw (bug b)', () => {
      const h = harness('ranked', [human(), fixedAi([330, 560])])
      h.clock.advance(1000 + 150)
      h.standoff.shot(0, 150, 0)
      h.clock.advance(1000)
      expect(h.verdict()).toEqual({
        kind: 'ranked',
        outcome: 'loss',
        reactionMs: 150,
        enemyMs: 560,
        targetsHit: 1,
      })
    })

    it('a shot at a dead target goes to the one still standing (bug c)', () => {
      const h = harness('ranked', [human(), fixedAi([330, 560])])
      h.clock.advance(1000 + 150)
      h.standoff.shot(0, 150, 0)
      h.clock.advance(100)
      h.standoff.shot(0, 250, 0)
      expect(h.verdict()).toMatchObject({ outcome: 'win', targetsHit: 2 })
    })

    it('a loss by being shot reports only live outlaws', () => {
      const h = harness('ranked', [human(), fixedAi([330, 560])])
      h.clock.advance(1000 + 150)
      h.standoff.shot(0, 150, 0)
      h.clock.advance(450)
      h.standoff.shot(0, 600, 1)
      expect(h.verdict()).toMatchObject({ outcome: 'loss', reactionMs: 150, enemyMs: 560 })
    })
  })

  it('refuses a ranked standoff without a human in seat 0', () => {
    expect(() => harness('ranked', [fixedAi([1]), human()])).toThrow()
  })
})

describe('pvp standoff', () => {
  it('sends the call to both humans on the same tick and picks the faster', () => {
    const h = harness('pvp', [human(50, 0, 50), human(50, 0, 50)])
    h.clock.advance(1000)
    expect(h.calls).toEqual([0, 1])
    expect(h.standoff.callTimes).toEqual([h.clock.now(), h.clock.now()])
    h.clock.advance(270)
    h.standoff.shot(0, 220)
    expect(h.verdict()).toBeNull()
    h.clock.advance(20)
    h.standoff.shot(1, 240)
    expect(h.verdict()).toMatchObject({ kind: 'win', winner: 0, ms: [220, 240] })
  })

  it('resolves for the only shooter once the other can no longer win', () => {
    const h = harness('pvp', [human(50, 0, 50), human(50, 0, 50)])
    h.clock.advance(1000 + 270)
    h.standoff.shot(0, 220)
    h.clock.advance(24)
    expect(h.verdict()).toBeNull()
    h.clock.advance(2)
    expect(h.verdict()).toMatchObject({ kind: 'win', winner: 0 })
  })

  it('a press during a fake-out is cowardice, with on-cue stats', () => {
    const h = harness('pvp', [human(), human()], {
      cues: [{ atMs: 500, cue: 'crow' }],
      callAtMs: 2000,
    })
    h.clock.advance(700)
    expect(h.log).toEqual(['cue:crow'])
    h.standoff.shot(1, null)
    expect(h.verdict()).toMatchObject({ kind: 'coward', who: 1 })
    expect(h.stats()).toEqual({ fakesSeen: 1, coward: { seat: 1, onCue: true }, waitedMs: 700 })
  })

  it('both freezing is a freeze', () => {
    const h = harness('pvp', [human(), human()])
    h.clock.advance(1000 + 1600)
    expect(h.verdict()).toMatchObject({ kind: 'froze' })
  })

  it('a dead heat is reported', () => {
    const h = harness('pvp', [human(), human()])
    h.clock.advance(1000 + 220)
    h.standoff.shot(0, 220)
    h.clock.advance(3)
    h.standoff.shot(1, 223)
    expect(h.verdict()).toMatchObject({ kind: 'dead_heat' })
  })

  it('ignores shots after the verdict and after abort', () => {
    const h = harness('pvp', [human(), human()])
    h.standoff.abort()
    h.clock.advance(5000)
    h.standoff.shot(0, 200)
    expect(h.verdict()).toBeNull()
    expect(h.clock.pending).toBe(0)
  })

  describe('against a ghost', () => {
    it('the ghost lands at its sampled time', () => {
      const h = harness('pvp', [human(), fixedAi([260])])
      h.clock.advance(1000)
      expect(h.calls).toEqual([0])
      h.clock.advance(300)
      expect(h.verdict()).toMatchObject({ kind: 'win', winner: 1, ms: [null, 260] })
    })
    it('a faster human beats it', () => {
      const h = harness('pvp', [human(), fixedAi([260])])
      h.clock.advance(1000 + 200)
      h.standoff.shot(0, 200)
      expect(h.verdict()).toMatchObject({ kind: 'win', winner: 0, ms: [200, 260] })
    })
    it('a flinching ghost cowards on a cue', () => {
      const h = harness('pvp', [human(), fixedAi([260], true)], {
        cues: [{ atMs: 500, cue: 'dog' }],
        callAtMs: 3000,
      })
      h.clock.advance(1000)
      expect(h.verdict()).toMatchObject({ kind: 'coward', who: 1 })
    })
    it('a nervous ghost can break on its own', () => {
      const h = harness('pvp', [human(), fixedAi([260], false, 1000)], { cues: [], callAtMs: 3000 })
      h.clock.advance(3000)
      expect(h.verdict()).toMatchObject({ kind: 'coward', who: 1 })
      expect(h.calls).toHaveLength(0)
    })
    it('a frozen ghost loses to any shot', () => {
      const h = harness('pvp', [human(), fixedAi([])])
      h.clock.advance(1000 + 900)
      h.standoff.shot(0, 900)
      expect(h.verdict()).toMatchObject({ kind: 'win', winner: 0, ms: [900, null] })
    })
  })
})

describe('ghost opponent', () => {
  const traits = {
    reactions: [200, 210, 220, 230, 240],
    duels: 80,
    froze: 0,
    fakesSeen: 100,
    fakeCowards: 0,
    waitCowards: 0,
    waitSeconds: 600,
  }
  it('samples its recorded draws, with noise, never under 140 ms', () => {
    const ghost = ghostOpponent({ ...traits, reactions: [100, 230] }, seeded(9))
    const draws = Array.from({ length: 200 }, () => ghost.draw()).flat()
    expect(draws.length).toBeGreaterThan(150)
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(140)
    expect(Math.max(...draws)).toBeLessThan(270)
  })
  it('uses the spec chances', () => {
    expect(ghostChances(traits)).toEqual({
      freeze: 0.5 / 100,
      cueCoward: 1 / 120,
      hazard: 0.5 / 660,
    })
  })
})

describe('the call sent ahead (lead)', () => {
  function leadHarness(
    seats: [HumanOpponent | AiOpponent, HumanOpponent | AiOpponent],
    mode: 'ranked' | 'pvp' = 'pvp',
  ) {
    const clock = new FakeClock()
    const calls: [Seat, number][] = []
    let verdict: Verdict | null = null
    const standoff = new Standoff({
      mode,
      seats,
      plan: { cues: [], callAtMs: 1000 },
      clock,
      rng: seeded(7),
      leadMs: CALL_LEAD_MS,
      events: {
        cue: () => undefined,
        call: (seat, inMs) => calls.push([seat, inMs]),
        end: (v) => {
          verdict = v
        },
      },
    })
    standoff.start()
    return { clock, calls, standoff, verdict: (): Verdict | null => verdict }
  }

  it('goes out lead ms early with inMs, and the call is timed from when it is presented', () => {
    const h = leadHarness([human(50, 0, 50), human(50, 0, 50)])
    h.clock.advance(1000 - CALL_LEAD_MS)
    expect(h.calls).toEqual([
      [0, CALL_LEAD_MS],
      [1, CALL_LEAD_MS],
    ])
    expect(h.standoff.phase).toBe('waiting')
    expect(h.standoff.callTimes).toEqual([
      h.clock.now() + CALL_LEAD_MS,
      h.clock.now() + CALL_LEAD_MS,
    ])
    h.clock.advance(CALL_LEAD_MS)
    expect(h.standoff.phase).toBe('called')
    // judged exactly as a call sent at the call: 220 ms reaction plus a 50 ms round trip
    h.clock.advance(270)
    h.standoff.shot(0, 220)
    h.clock.advance(20)
    h.standoff.shot(1, 240)
    expect(h.verdict()).toMatchObject({ kind: 'win', winner: 0, ms: [220, 240] })
  })

  it('a shot inside the lead (before the call is presented) is an early draw', () => {
    const h = leadHarness([human(), human()])
    h.clock.advance(1000 - CALL_LEAD_MS + 100)
    h.standoff.shot(1, null)
    expect(h.verdict()).toMatchObject({ kind: 'coward', who: 1 })
  })

  it('ranked: the lead does not move the judged reaction', () => {
    const h = leadHarness([human(40), fixedAi([400])], 'ranked')
    h.clock.advance(1000)
    h.clock.advance(250 + 40)
    h.standoff.shot(0, 250)
    expect(h.verdict()).toMatchObject({ kind: 'ranked', outcome: 'win', reactionMs: 250 })
  })
})
