import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  baseBounty,
  bountyForLevel,
  DAILY_FIRST_WIN_XP,
  dailyWinBonus,
  duelPayout,
  duelPenalty,
  levelForXp,
  levelRewards,
} from '../../../src/experiments/out-west/data/progression.ts'
import { createProfile, getProfile } from '../economy/profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from '../economy/testing/d1.ts'
import { eligibleGhosts, loadGhostTraits } from './ghost.ts'
import { buildSettlement, type HumanSeat, pairHistory, type SettleInput } from './settle.ts'
import { accountDeletionStatements, duelStats, setGhostOptOutStatements } from './stats.ts'

let t: TestDb

beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

async function player(name: string): Promise<string> {
  const id = freshId(name)
  await insertAccount(t.db, id, name)
  await createProfile(t.env, id, name)
  return id
}

async function seat(accountId: string): Promise<HumanSeat> {
  const profile = await getProfile(t.env, accountId)
  if (!profile) {
    throw new Error('no profile')
  }
  return { accountId, profile, stats: await duelStats(t.env, accountId) }
}

const base = (over: Partial<SettleInput>): SettleInput => ({
  matchId: `${freshId('room')}:0`,
  rematch: 0,
  mode: 'pvp',
  outcome: 'win',
  winner: 0,
  culprit: null,
  reactions: [210, 260],
  deadHeats: 0,
  humans: [null as unknown as HumanSeat, null],
  ghost: null,
  wait: { fakesSeen: 1, coward: null, waitedMs: 3000 },
  rtts: [40, 50],
  flags: 0,
  pairMatchNumber: 1,
  pairFactor: 1,
  pairRecent: [],
  startedAt: Date.now() - 20_000,
  now: Date.now(),
  ...over,
})

async function settle(input: SettleInput) {
  const out = buildSettlement(t.env, input)
  await t.db.batch(out.statements)
  return out
}

describe('settlement (real D1)', () => {
  it('pays the winner, charges the loser, writes the match, stats, pair and ghost samples', async () => {
    const [a, b] = [await player('Winner'), await player('Loser')]
    const [sa, sb] = [await seat(a), await seat(b)]
    const out = await settle(base({ humans: [sa, sb] }))
    const payout = duelPayout({ loserBounty: bountyForLevel(1), reactionMs: 210 })
    const daily = dailyWinBonus(baseBounty(1))
    const penalty = duelPenalty(250, bountyForLevel(1))
    // The XP crosses level 2, and the ledger pays the level reward in the same batch.
    const reward = levelRewards(1, levelForXp(120 + DAILY_FIRST_WIN_XP))
    expect(out.settlements[0]?.delta).toBe(payout + daily + reward)
    expect(out.settlements[1]?.delta).toBe(-penalty)
    expect((await getProfile(t.env, a))?.purse).toBe(250 + payout + daily + reward)
    expect((await getProfile(t.env, b))?.purse).toBe(250 - penalty)
    const statsA = await duelStats(t.env, a)
    expect(statsA).toMatchObject({ streak: 1, wins: 1, recent: [210] })
    expect((await duelStats(t.env, b)).losses).toBe(1)
    const pair = await pairHistory(t.env, a, b, Date.now())
    expect(pair.matchNumber).toBe(2)
    const traits = await loadGhostTraits(t.env, a)
    expect(traits?.reactions).toEqual([210])
    expect(traits?.fakesSeen).toBe(1)
    expect(out.settlements[0]?.xp).toBe(120 + DAILY_FIRST_WIN_XP)
  })

  it('rematches show only their own level reward, matching the ledger ($75, not $125)', async () => {
    const [a, b] = [await player('Climber'), await player('Sparring')]
    const room = freshId('room')
    const first = await settle(
      base({ matchId: `${room}:0`, humans: [await seat(a), await seat(b)] }),
    )
    const one = first.settlements[0]
    expect(one).toMatchObject({ levelBefore: 1, levelAfter: 2, levelReward: 50 })
    expect(one?.lines.at(-1)).toEqual({ label: 'Level up · Lv 2', amount: 50, xp: 0 })
    // The rematch is built on the profile as it is now, not on the XP from when they queued.
    const second = await settle(
      base({ matchId: `${room}:1`, rematch: 1, humans: [await seat(a), await seat(b)] }),
    )
    const two = second.settlements[0]
    expect(two?.xpBefore).toBe(one?.xpAfter)
    expect(two).toMatchObject({ levelBefore: 2, levelAfter: 3, levelReward: 75 })
    const { results } = await t.db
      .prepare(
        "SELECT idem_key, delta FROM ledger WHERE account_id = ? AND kind = 'level_reward' ORDER BY id",
      )
      .bind(a)
      .all<{ idem_key: string; delta: number }>()
    expect(results.map((r) => r.delta)).toEqual([50, 75])
    expect(results[1]?.idem_key.startsWith(`match:${room}:1#`)).toBe(true)
  })

  it('a Badlands winner is paid nothing but keeps the XP; the honest loser still pays', async () => {
    const [a, b] = [await player('Shadow'), await player('Mark')]
    const sa = { ...(await seat(a)), frozen: true }
    const out = await settle(base({ humans: [sa, await seat(b)] }))
    const win = out.settlements[0]
    expect(win?.lines.filter((l) => l.amount > 0 && !l.label.startsWith('Level up'))).toEqual([])
    expect(win?.xp).toBeGreaterThan(0)
    const { results } = await t.db
      .prepare(
        "SELECT COALESCE(SUM(delta), 0) AS cash FROM ledger WHERE account_id = ? AND kind = 'duel_win'",
      )
      .bind(a)
      .all<{ cash: number }>()
    expect(results[0]?.cash).toBe(0)
    expect((await getProfile(t.env, b))?.purse).toBe(250 - duelPenalty(250, bountyForLevel(1)))
  })

  it('a replay of the same settlement pays nothing twice', async () => {
    const [a, b] = [await player('Replay'), await player('Victim')]
    const input = base({ humans: [await seat(a), await seat(b)] })
    await settle(input)
    const purse = (await getProfile(t.env, a))?.purse
    await expect(t.db.batch(buildSettlement(t.env, input).statements)).rejects.toThrow()
    expect((await getProfile(t.env, a))?.purse).toBe(purse)
  })

  it('a coward pays full and gets a tally; the honest player is paid', async () => {
    const [a, b] = [await player('Honest'), await player('Yellow')]
    const out = await settle(
      base({
        humans: [await seat(a), await seat(b)],
        outcome: 'coward',
        winner: 0,
        culprit: 1,
        reactions: [null, null],
        wait: { fakesSeen: 1, coward: { seat: 1, onCue: true }, waitedMs: 1500 },
      }),
    )
    expect(out.settlements[1]?.delta).toBe(-duelPenalty(250, bountyForLevel(1)))
    expect((await duelStats(t.env, b)).cowardice).toBe(1)
    expect((await loadGhostTraits(t.env, b))?.fakeCowards).toBe(1)
  })

  it('dead heats and freezes pay XP only', async () => {
    const [a, b] = [await player('Heat'), await player('Heat2')]
    const out = await settle(
      base({ humans: [await seat(a), await seat(b)], outcome: 'draw', winner: null, deadHeats: 2 }),
    )
    expect(out.settlements[0]).toMatchObject({ delta: 0, xp: 50 })
    const froze = await settle(
      base({
        humans: [await seat(a), await seat(b)],
        outcome: 'froze',
        winner: null,
        reactions: [null, null],
      }),
    )
    expect(froze.settlements[1]).toMatchObject({ delta: 0, xp: 25 })
    // booked as standoffs, not wins: the hub labels them "Standoff: …", never "Bounty Hunt win"
    const kinds = await t.db
      .prepare('SELECT kind, delta, xp FROM ledger WHERE account_id = ? AND ref LIKE ? ORDER BY id')
      .bind(a, 'room%')
      .all<{ kind: string; delta: number; xp: number }>()
    expect(kinds.results).toEqual([
      { kind: 'duel_draw', delta: 0, xp: 50 },
      { kind: 'duel_froze', delta: 0, xp: 25 },
    ])
  })

  it('a dodge costs half and pays the other nothing', async () => {
    const [a, b] = [await player('Waiting'), await player('Dodger')]
    const out = await settle(
      base({
        humans: [await seat(a), await seat(b)],
        outcome: 'dodge',
        winner: 0,
        culprit: 1,
        reactions: [null, null],
      }),
    )
    expect(out.settlements[0]).toMatchObject({ delta: 0, xp: 0 })
    expect(out.settlements[1]?.delta).toBe(-duelPenalty(250, bountyForLevel(1), { dodge: true }))
    expect((await duelStats(t.env, b)).dodges).toHaveLength(1)
  })

  it('pair diminishing returns scale the money', async () => {
    const [a, b] = [await player('Farm'), await player('Alt')]
    const out = await settle(
      base({ humans: [await seat(a), await seat(b)], pairFactor: 0.5, pairMatchNumber: 3 }),
    )
    const payout = duelPayout({ loserBounty: bountyForLevel(1), reactionMs: 210, pairFactor: 0.5 })
    expect(out.settlements[0]?.lines[0]?.amount).toBe(payout)
  })

  it('a ghost win pays the owner a royalty; a ghost loss costs half', async () => {
    const [human, owner] = [await player('Greenhorn'), await player('GhostOwner')]
    const out = await settle(
      base({
        mode: 'ghost',
        humans: [await seat(human), null],
        ghost: { ownerId: owner, level: 1, prestige: 0, royaltiesToday: 0 },
        winner: 1,
        reactions: [null, 240],
        rtts: [40, null],
      }),
    )
    const penalty = duelPenalty(250, bountyForLevel(1), { ghost: true })
    expect(out.settlements[0]?.delta).toBe(-penalty)
    expect((await getProfile(t.env, owner))?.purse).toBe(250 + 5 + Math.round(penalty * 0.1))
  })

  it('opting out and deleting the account remove the ghost', async () => {
    const [a, b] = [await player('Shy'), await player('Other')]
    await settle(base({ humans: [await seat(a), await seat(b)] }))
    await t.db.batch(setGhostOptOutStatements(t.env, a, true))
    expect(await loadGhostTraits(t.env, a)).toBeNull()
    await t.db.batch(accountDeletionStatements(t.env, b))
    const row = await t.db
      .prepare('SELECT COUNT(*) AS n FROM matches WHERE b_id = ?')
      .bind(b)
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
    expect((await eligibleGhosts(t.env)).some((g) => g.accountId === a || g.accountId === b)).toBe(
      false,
    )
  })
})
