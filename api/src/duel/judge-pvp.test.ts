import { describe, expect, it } from 'bun:test'
import { JUDGE_TIMEOUT_MS } from '../../../src/experiments/out-west/contract/duel.ts'
import {
  judgePvp,
  linkOkForPvp,
  type PvpJudgeInput,
  type PvpLink,
  pvpReaction,
  rttCapped,
  rttFor,
  TIE_MS,
  tolFor,
} from './judge-pvp.ts'

const link = (median: number, jitter = 0, tcp: number | null = median): PvpLink => ({
  median,
  jitter,
  tcp,
})

/** Both calls go out at t=1000. */
const base = (over: Partial<PvpJudgeInput> = {}): PvpJudgeInput => ({
  callSentAt: [1000, 1000],
  shotSeenAt: [null, null],
  localMs: [null, null],
  rtt: [link(50), link(50)],
  now: 1000,
  ...over,
})

describe('rttFor / tolFor', () => {
  it('uses the app median when it agrees with TCP', () => {
    expect(rttFor(link(60, 5, 55))).toBe(60)
    expect(tolFor(link(60, 5, 55))).toBe(30)
  })
  it('caps a pong-delayer at tcpRtt + 40 and strips their jitter slack', () => {
    const cheat = link(400, 40, 30)
    expect(rttCapped(cheat)).toBe(true)
    expect(rttFor(cheat)).toBe(70)
    expect(tolFor(cheat)).toBe(20)
  })
  it('falls back to the app median without a TCP figure', () => {
    expect(rttFor(link(80, 0, null))).toBe(80)
  })
  it('caps tolerance at 60', () => {
    expect(tolFor(link(60, 45, 60))).toBe(60)
  })
  it('keeps bad links out of human duels', () => {
    expect(linkOkForPvp(link(80, 10))).toBe(true)
    expect(linkOkForPvp(link(300, 10))).toBe(false)
    expect(linkOkForPvp(link(80, 60))).toBe(false)
  })
})

describe('pvpReaction', () => {
  const l = link(50, 0)
  it('trusts an honest client', () => {
    // Pressed at 220, the shot arrives 50 ms later: observed 270, floor 270-50-20 = 200.
    expect(pvpReaction(1000, 1270, 220, l)).toBe(220)
  })
  it('clamps a client that fakes a tiny localMs', () => {
    expect(pvpReaction(1000, 1270, 120, l)).toBe(200)
  })
  it('a client claiming slower than observed is capped at observed', () => {
    expect(pvpReaction(1000, 1270, 900, l)).toBe(270)
  })
  it('a press before the call is cowardice (null)', () => {
    expect(pvpReaction(1000, 1100, null, l)).toBeNull()
    expect(pvpReaction(1000, 990, 50, l)).toBeNull()
    expect(pvpReaction(1000, 1300, Number.NaN, l)).toBeNull()
    expect(pvpReaction(1000, 1300, -5, l)).toBeNull()
  })
  it('delaying the shot message to wait and see costs the delayer', () => {
    // Honest press at 220 but held back 100 ms: the floor is now 300, so the claim is overridden.
    expect(pvpReaction(1000, 1370, 220, l)).toBe(300)
  })
  it('delaying pongs buys nothing beyond the TCP cap', () => {
    const honest = pvpReaction(1000, 1270, 120, link(50, 0, 50))
    const delayer = pvpReaction(1000, 1270, 120, link(500, 40, 50))
    // The delayer's RTT is capped at 90 (vs 50), so their floor is 40 ms lower at most.
    expect(honest).toBe(200)
    expect(delayer).toBe(270 - 90 - 20)
  })
})

describe('judgePvp', () => {
  it('stays pending before anyone fires', () => {
    const v = judgePvp(base({ now: 1300 }))
    expect(v.kind).toBe('pending')
  })

  it('the faster shot wins once both are in', () => {
    const v = judgePvp(base({ shotSeenAt: [1270, 1300], localMs: [220, 240], now: 1300 }))
    expect(v).toEqual({ kind: 'win', winner: 0, ms: [220, 240] })
  })

  it('waits until the slower player can no longer win', () => {
    // Seat 0 shot at R=220. Seat 1 (rtt 50, tol 20) could still come in under 225 until
    // 1000 + 50 + 20 + 225 = 1295.
    const shot = { shotSeenAt: [1270, null] as const, localMs: [220, null] as const }
    const early = judgePvp(base({ ...shot, now: 1280 }))
    expect(early).toEqual({ kind: 'pending', recheckAt: 1296 })
    const late = judgePvp(base({ ...shot, now: 1296 }))
    expect(late).toEqual({ kind: 'win', winner: 0, ms: [220, null] })
  })

  it('a later-arriving but faster shot from a laggier player still wins', () => {
    // Seat 1 has 150 ms RTT: reacted at 210 and the shot arrived at 1000 + 210 + 150 = 1360.
    const v = judgePvp(
      base({
        rtt: [link(50), link(150)],
        shotSeenAt: [1270, 1360],
        localMs: [220, 210],
        now: 1360,
      }),
    )
    expect(v).toEqual({ kind: 'win', winner: 1, ms: [220, 210] })
  })

  it(`calls a dead heat within ${TIE_MS} ms`, () => {
    const v = judgePvp(base({ shotSeenAt: [1270, 1275], localMs: [220, 224], now: 1275 }))
    expect(v.kind).toBe('dead_heat')
    const apart = judgePvp(base({ shotSeenAt: [1270, 1276], localMs: [220, 226], now: 1276 }))
    expect(apart.kind).toBe('win')
  })

  it('a shot under 100 ms is cowardice', () => {
    const v = judgePvp(base({ shotSeenAt: [1130, null], localMs: [80, null], now: 1130 }))
    expect(v).toEqual({ kind: 'coward', who: 0, ms: [null, null] })
  })

  it('a faked localMs cannot dodge the coward floor or win', () => {
    // Seat 1 pre-fired, the shot reached the server 60 ms after the call, and they claim 150 ms.
    // The floor is 60-50-20 < 0, so localMs is capped at observed = 60: cowardice.
    const v = judgePvp(base({ shotSeenAt: [null, 1060], localMs: [null, 150], now: 1060 }))
    expect(v).toEqual({ kind: 'coward', who: 1, ms: [null, null] })
  })

  it('the first of two cowards is the coward', () => {
    const v = judgePvp(base({ shotSeenAt: [1040, 1020], localMs: [null, null], now: 1040 }))
    expect(v).toMatchObject({ kind: 'coward', who: 1 })
  })

  it('nobody firing within the timeout is a freeze', () => {
    const t = 1000 + 50 + 20 + JUDGE_TIMEOUT_MS + 1
    expect(judgePvp(base({ now: t - 2 })).kind).toBe('pending')
    expect(judgePvp(base({ now: t })).kind).toBe('froze')
  })

  it('a shot slower than the timeout counts as not firing', () => {
    const v = judgePvp(base({ shotSeenAt: [2700, null], localMs: [1650, null], now: 2700 }))
    expect(v.kind).toBe('froze')
  })

  it('one frozen seat loses to any shot', () => {
    const t = 1000 + 50 + 20 + JUDGE_TIMEOUT_MS + 1
    const v = judgePvp(base({ shotSeenAt: [1500, null], localMs: [450, null], now: t }))
    expect(v).toEqual({ kind: 'win', winner: 0, ms: [450, null] })
  })

  it('a pong-delayer gains at most the TCP slack', () => {
    // Seat 1 really reacted at 260 (slower than seat 0 at 230) and delayed pongs to look 400 ms away.
    // Real RTT 50, so the shot arrives at 1310. Capped rtt 90 → floor 1310-1000-90-20 = 200.
    // Claiming 200 beats seat 0, but only within the cap; a 40+ ms slower player can't steal it.
    const fair = judgePvp(
      base({
        rtt: [link(50), link(400, 40, 50)],
        shotSeenAt: [1280, 1310],
        localMs: [230, 200],
        now: 1310,
      }),
    )
    expect(fair).toMatchObject({ kind: 'win', winner: 1 })
    const slow = judgePvp(
      base({
        rtt: [link(50), link(400, 40, 50)],
        shotSeenAt: [1280, 1360],
        localMs: [230, 150],
        now: 1360,
      }),
    )
    expect(slow).toMatchObject({ kind: 'win', winner: 0 })
  })

  describe('against a fixed (ghost) side', () => {
    const ghost = (ms: number | null) => ({ fixed: [undefined, { ms }] as const })
    it('the human wins with a faster shot', () => {
      const v = judgePvp(
        base({ ...ghost(260), shotSeenAt: [1270, null], localMs: [220, null], now: 1270 }),
      )
      expect(v).toEqual({ kind: 'win', winner: 0, ms: [220, 260] })
    })
    it('the ghost wins once the human can no longer beat it', () => {
      expect(judgePvp(base({ ...ghost(260), now: 1300 })).kind).toBe('pending')
      const v = judgePvp(base({ ...ghost(260), now: 1000 + 70 + 265 + 1 }))
      expect(v).toEqual({ kind: 'win', winner: 1, ms: [null, 260] })
    })
    it('dead heat against a ghost', () => {
      const v = judgePvp(
        base({ ...ghost(222), shotSeenAt: [1270, null], localMs: [220, null], now: 1270 }),
      )
      expect(v.kind).toBe('dead_heat')
    })
    it('a frozen ghost loses to any shot and freezes with a frozen human', () => {
      const shot = judgePvp(
        base({ ...ghost(null), shotSeenAt: [1900, null], localMs: [800, null], now: 1900 }),
      )
      expect(shot).toMatchObject({ kind: 'win', winner: 0 })
      const both = judgePvp(base({ ...ghost(null), now: 3000 }))
      expect(both.kind).toBe('froze')
    })
  })
})
