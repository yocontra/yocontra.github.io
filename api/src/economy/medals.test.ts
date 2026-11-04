/**
 * Medals, challenges and the solo cosmetics (meta-game stream): the pure rules in data/medals.ts,
 * and the account side in economy/medals.ts against a real local D1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { CATALOG, itemById } from '../../../src/experiments/out-west/data/catalog.ts'
import {
  CHALLENGES,
  GUEST_CAP,
  guestCredit,
  isClaim,
  MEDAL_MS,
  maxSoloPay,
  medalPay,
  OUTLAW_COUNT,
  SOLO_REWARDS,
  tierFor,
} from '../../../src/experiments/out-west/data/medals.ts'
import { OUTLAWS, RIFLEMAN } from '../../../src/experiments/out-west/data/outlaws.ts'
import { storeLevel } from '../../../src/experiments/out-west/data/progression.ts'
import { creditJobFor, RankedCredits } from '../ranked/credit.ts'
import { newRun } from '../ranked/run-state.ts'
import { BOSS_LEVEL, tuningFor } from '../tuning.ts'
import { auditLedger } from './audit.ts'
import { claimStatements, marksOf, medalStatements, type SoloEvidence } from './medals.ts'
import { createProfile, getProfileDetail, ownedItems } from './profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from './testing/d1.ts'

let t: TestDb
beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

async function newPlayer(): Promise<string> {
  const id = freshId()
  await insertAccount(t.db, id, 'Medal')
  await createProfile(t.env, id, 'Medal')
  return id
}

const ev = (o: Partial<SoloEvidence> = {}): SoloEvidence => ({
  reactionMs: 300,
  fakesSeen: 0,
  firstTry: false,
  clean: true,
  ...o,
})

async function winOn(id: string, level: number, runId: string, e: SoloEvidence): Promise<void> {
  const s = await medalStatements(t.env, { accountId: id, level, runId, ev: e })
  if (s.length > 0) {
    await t.db.batch(s)
  }
}

async function ledgerOf(id: string, kind: string) {
  const { results } = await t.db
    .prepare('SELECT delta, xp, idem_key FROM ledger WHERE account_id = ? AND kind = ? ORDER BY id')
    .bind(id, kind)
    .all<{ delta: number; xp: number; idem_key: string }>()
  return results
}

describe('medal thresholds', () => {
  /** The draw a win has to beat, per slot (Delmer's first shot always misses; see the lead's table). */
  const toBeat = (i: number): number => {
    const o = OUTLAWS[i]
    if (!o) {
      return 0
    }
    if (o.gimmick === 'two-guns') {
      return 465
    }
    if (o.gimmick === 'underboss') {
      return RIFLEMAN.draw
    }
    if (i === BOSS_LEVEL) {
      return tuningFor(BOSS_LEVEL, 2)?.targets[0]?.drawMs ?? 0
    }
    return tuningFor(i)?.targets[0]?.drawMs ?? o.draw
  }

  it('one row per outlaw, gold < silver < bronze, bronze under his draw', () => {
    expect(MEDAL_MS).toHaveLength(OUTLAWS.length)
    for (const [i, [b, s, g]] of MEDAL_MS.entries()) {
      expect(g).toBeLessThan(s)
      expect(s).toBeLessThan(b)
      expect(b).toBeLessThan(toBeat(i))
    }
  })

  it('tiers are strict and nonsense reactions earn nothing', () => {
    const [b, s, g] = MEDAL_MS[0] as readonly [number, number, number]
    expect(tierFor(0, b)).toBe(0)
    expect(tierFor(0, b - 1)).toBe(1)
    expect(tierFor(0, s - 1)).toBe(2)
    expect(tierFor(0, g - 1)).toBe(3)
    expect(tierFor(0, null)).toBe(0)
    expect(tierFor(0, -5)).toBe(0)
    expect(tierFor(0, Number.NaN)).toBe(0)
    expect(tierFor(17, 100)).toBe(0)
  })

  it('pays 25/40/60 XP and $15/$30/$60, cumulatively', () => {
    expect(medalPay(0, 3)).toEqual({ xp: 125, cash: 105 })
    expect(medalPay(1, 3)).toEqual({ xp: 100, cash: 90 })
    expect(medalPay(3, 3)).toEqual({ xp: 0, cash: 0 })
    // 17 × 125 + 14 × 50 + 3 × 50 XP; 17 × $105 + 14 × $40
    expect(maxSoloPay()).toEqual({ xp: 2975, cash: 2345 })
  })
})

describe('challenges', () => {
  it('one per outlaw with stable, unique ids; three hat claims', () => {
    expect(CHALLENGES).toHaveLength(OUTLAW_COUNT)
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(OUTLAW_COUNT)
    for (const [i, c] of CHALLENGES.entries()) {
      expect(c.level).toBe(i)
      expect(c.id.startsWith(`ch.${i + 1}.`)).toBe(true)
    }
    expect(CHALLENGES.filter(isClaim).map((c) => c.id)).toEqual([
      'ch.2.hat',
      'ch.4.hat',
      'ch.6.hat',
    ])
  })

  it('every server-judged challenge is possible with one fake-out (the ranked wait has at most one)', () => {
    const fakeRules = CHALLENGES.flatMap((c) =>
      c.rule.kind === 'fakes' || c.rule.kind === 'fakesFirstTry'
        ? [{ min: c.rule.min, chance: tuningFor(c.level)?.fakeChance ?? 0 }]
        : [],
    )
    expect(fakeRules.length).toBeGreaterThan(0)
    // at most one fake-out needed, and the outlaw has fake-outs to give
    expect(fakeRules.filter((r) => r.min > 1 || r.chance <= 0)).toEqual([])
  })
})

describe('solo rewards', () => {
  it('ten catalog reward items, none for sale', () => {
    expect(SOLO_REWARDS).toHaveLength(10)
    for (const r of SOLO_REWARDS) {
      const item = itemById(r.item)
      expect(item?.source).toBe('reward')
      expect(item?.price).toBe(0)
    }
    expect(CATALOG.filter((i) => i.source === 'reward').length).toBeGreaterThanOrEqual(14)
  })
})

describe('guest credit', () => {
  it('prices the device progress with the account rules and caps it', () => {
    const none = guestCredit({ marks: [], clears: 0 })
    expect(none).toEqual({ xp: 0, cash: 0, raw: { xp: 0, cash: 0 } })
    const one = guestCredit({ marks: [{ tier: 3, challenge: true }], clears: 1 })
    // first clear 40 XP $5, gold 125 XP $105, challenge 50 XP $40
    expect(one.raw).toEqual({ xp: 215, cash: 150 })
    expect(one.xp).toBe(215)
    const all = guestCredit({
      marks: Array.from({ length: 17 }, () => ({ tier: 3, challenge: true })),
      clears: (1 << 17) - 1,
    })
    expect(all.raw.xp).toBe(2720 + 2975)
    expect(all.xp).toBe(GUEST_CAP.xp)
    expect(all.cash).toBe(GUEST_CAP.cash)
  })

  it('ignores junk tiers and extra bits', () => {
    const junk = guestCredit({
      marks: [
        { tier: 99, challenge: true },
        { tier: -4, challenge: false },
      ],
      clears: 1.5,
    })
    expect(junk.raw).toEqual({ xp: 175, cash: 145 })
  })
})

describe('store level', () => {
  it('solo levels count ~3.3× toward the gates; PvP levels count once', () => {
    expect(storeLevel({ level: 1, xp: 0, soloXp: 0 })).toBe(1)
    // L11 entirely from the gauntlet shops as L35
    expect(storeLevel({ level: 11, xp: 6050, soloXp: 6050 })).toBe(35)
    // L11 entirely from Bounty Hunt: unchanged
    expect(storeLevel({ level: 11, xp: 6050, soloXp: 0 })).toBe(11)
    expect(storeLevel({ level: 50, xp: 101_430, soloXp: 101_430 })).toBe(50)
    // a bogus solo figure can't exceed the XP it came with
    expect(storeLevel({ level: 2, xp: 150, soloXp: 1e9 })).toBe(5)
  })
})

describe('medalStatements', () => {
  it('a gold pays all three tiers once; a replay and a slower win pay nothing', async () => {
    const id = await newPlayer()
    await winOn(id, 0, 'run-a', ev({ reactionMs: 200 }))
    const rows = await ledgerOf(id, 'medal')
    expect(rows.map((r) => [r.delta, r.xp])).toEqual([
      [15, 25],
      [30, 40],
      [60, 60],
    ])
    await winOn(id, 0, 'run-a', ev({ reactionMs: 200 }))
    await winOn(id, 0, 'run-b', ev({ reactionMs: 300 }))
    expect(await ledgerOf(id, 'medal')).toHaveLength(3)
    const marks = await marksOf(t.env, id)
    expect(marks[0]).toEqual({ tier: 3, bestMs: 200, challenge: false })
    const p = await getProfileDetail(t.env, id)
    expect(p?.purse).toBe(250 + 105)
    expect(p?.soloXp).toBe(125)
    expect((await auditLedger(t.env)).mismatches).toEqual([])
  })

  it('bronze then gold pays the difference only', async () => {
    const id = await newPlayer()
    await winOn(id, 5, 'r1', ev({ reactionMs: 355 }))
    await winOn(id, 5, 'r2', ev({ reactionMs: 210 }))
    expect((await ledgerOf(id, 'medal')).map((r) => r.xp)).toEqual([25, 40, 60])
  })

  it('a server-judged challenge pays once; a hat challenge is never paid from a win', async () => {
    const id = await newPlayer()
    // outlaw 1: first try
    await winOn(id, 0, 'r1', ev({ reactionMs: 500, firstTry: true }))
    await winOn(id, 0, 'r2', ev({ reactionMs: 500, firstTry: true }))
    // outlaw 2: a hat challenge (claim only)
    await winOn(id, 1, 'r1', ev({ reactionMs: 500, firstTry: true }))
    const ch = await ledgerOf(id, 'challenge')
    expect(ch.map((r) => [r.delta, r.xp])).toEqual([[40, 50]])
    const marks = await marksOf(t.env, id)
    expect(marks[0]?.challenge).toBe(true)
    expect(marks[1]?.challenge).toBe(false)
    // no medal under 500 ms on outlaw 1, but the win is recorded (for a claim)
    expect(marks[1]?.tier).toBe(0)
  })

  it('a fake-out challenge needs the fake-out', async () => {
    const id = await newPlayer()
    await winOn(id, 2, 'r1', ev({ fakesSeen: 0 }))
    expect(await ledgerOf(id, 'challenge')).toHaveLength(0)
    await winOn(id, 2, 'r2', ev({ fakesSeen: 1 }))
    expect(await ledgerOf(id, 'challenge')).toHaveLength(1)
  })

  it('Hardin without an early draw earns the Midnight Coat', async () => {
    const id = await newPlayer()
    await winOn(id, 16, 'r1', ev({ clean: false }))
    expect(await ownedItems(t.env, id)).not.toContain('outfit.midnight-coat')
    await winOn(id, 16, 'r2', ev({ clean: true }))
    expect(await ownedItems(t.env, id)).toContain('outfit.midnight-coat')
  })

  it('golds on all 17 earn the three medal sets and the satchel', async () => {
    const id = await newPlayer()
    for (let i = 0; i < 17; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential wins
      await winOn(id, i, 'full', ev({ reactionMs: 150 }))
    }
    const owned = await ownedItems(t.env, id)
    for (const item of [
      'hat.bronze-band',
      'holster.silver-conchos',
      'gun.gold-medal',
      'bag.medal-satchel',
    ]) {
      expect(owned as string[]).toContain(item)
    }
    expect(owned).not.toContain('frame.tall-tales')
    expect((await ledgerOf(id, 'medal')).length).toBe(51)
    expect((await auditLedger(t.env)).mismatches).toEqual([])
    // seventeen wins of reads and batches: give a busy machine room
  }, 30_000)

  it('refuses a bad outlaw or no account', async () => {
    expect(await medalStatements(t.env, { accountId: '', level: 0, runId: 'r', ev: ev() })).toEqual(
      [],
    )
    const id = await newPlayer()
    expect(
      await medalStatements(t.env, { accountId: id, level: 17, runId: 'r', ev: ev() }),
    ).toEqual([])
    expect(
      await medalStatements(t.env, { accountId: id, level: -1, runId: 'r', ev: ev() }),
    ).toEqual([])
  })
})

describe('claimStatements (hat shots)', () => {
  it('needs a recorded ranked win of that outlaw, on that run, within 15 minutes', async () => {
    const id = await newPlayer()
    const claim = (runId: string, now?: number) =>
      claimStatements(t.env, {
        accountId: id,
        challengeId: 'ch.2.hat',
        runId,
        ...(now ? { now } : {}),
      })
    expect(await claim('r1')).toBe('no_win')
    await winOn(id, 1, 'r1', ev())
    expect(await claim('r2')).toBe('no_win')
    expect(await claim('r1', Date.now() + 16 * 60 * 1000)).toBe('no_win')
    const ok = await claim('r1')
    if (typeof ok === 'string') {
      throw new Error(ok)
    }
    expect(ok.xp).toBe(50)
    await t.db.batch(ok.statements)
    expect(await claim('r1')).toBe('done')
    expect((await ledgerOf(id, 'challenge')).map((r) => [r.delta, r.xp])).toEqual([[0, 50]])
  })

  it('refuses unknown and server-judged challenges', async () => {
    const id = await newPlayer()
    expect(
      await claimStatements(t.env, { accountId: id, challengeId: 'ch.99.x', runId: 'r' }),
    ).toBe('unknown')
    expect(
      await claimStatements(t.env, { accountId: id, challengeId: 'ch.1.steady', runId: 'r' }),
    ).toBe('not_claim')
  })

  it('a replayed claim batch books nothing twice', async () => {
    const id = await newPlayer()
    await winOn(id, 3, 'r1', ev())
    const a = await claimStatements(t.env, { accountId: id, challengeId: 'ch.4.hat', runId: 'r1' })
    const b = await claimStatements(t.env, { accountId: id, challengeId: 'ch.4.hat', runId: 'r1' })
    if (typeof a === 'string' || typeof b === 'string') {
      throw new Error('refused')
    }
    await t.db.batch(a.statements)
    await t.db.batch(b.statements)
    expect(await ledgerOf(id, 'challenge')).toHaveLength(1)
  })
})

describe('the ranked credit job', () => {
  it('carries the evidence on a paid win and books medals through RankedCredits, idempotently', async () => {
    const id = await newPlayer()
    const run = newRun({
      sessionId: 'sess-credit',
      clientHash: 'h',
      accountId: id,
      accountName: 'Medal',
      now: Date.now(),
    })
    run.records.push({ level: 0, outcome: 'coward', reactionMs: -1 })
    run.records.push({ level: 0, outcome: 'win', reactionMs: 210 })
    const job = creditJobFor(run, {
      level: 0,
      outcome: 'win',
      reactionMs: 210,
      stats: { fakesSeen: 0, coward: null, waitedMs: 1500 },
      bossPhaseOne: false,
    })
    expect(job.solo).toEqual({ reactionMs: 210, fakesSeen: 0, firstTry: false, clean: false })
    const credits = new RankedCredits(t.env, () => undefined)
    await credits.apply(job)
    await credits.apply(job)
    expect((await ledgerOf(id, 'medal')).length).toBe(3)
    // not first try (an early draw came first), so no challenge
    expect(await ledgerOf(id, 'challenge')).toHaveLength(0)
    const loss = creditJobFor(run, {
      level: 0,
      outcome: 'loss',
      reactionMs: null,
      stats: { fakesSeen: 0, coward: null, waitedMs: 1500 },
      bossPhaseOne: false,
    })
    expect(loss.solo).toBeUndefined()
  })

  it('the boss phase one pays no medals', () => {
    const run = newRun({
      sessionId: 's',
      clientHash: 'h',
      accountId: 'a',
      accountName: 'A',
      now: 0,
    })
    const job = creditJobFor(run, {
      level: 16,
      outcome: 'win',
      reactionMs: 150,
      stats: { fakesSeen: 0, coward: null, waitedMs: 0 },
      bossPhaseOne: true,
    })
    expect(job.paidWin).toBe(false)
    expect(job.solo).toBeUndefined()
  })
})
