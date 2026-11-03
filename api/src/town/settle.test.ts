import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'
import { InputQueue } from '../../../src/experiments/out-west/ffa/sim/input.ts'
import { ClientStream } from '../../../src/experiments/out-west/ffa/sim/snapshot.ts'
import { newPlayer } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import { createProfileStatements } from '../economy/profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from '../economy/testing/d1.ts'
import type { Session, SettledDeposit } from './core.ts'
import {
  depositStatements,
  lobbyStatsStatement,
  sessionStartStatement,
  xpFlushStatements,
} from './settle.ts'

let t: TestDb

beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

async function account(): Promise<string> {
  const id = freshId('ffa')
  await insertAccount(t.db, id, 'Settler')
  await t.db.batch(createProfileStatements(t.env, id))
  return id
}

function session(accountId: string): Session {
  return {
    playerId: 0,
    accountId,
    name: 'Settler',
    sessionId: crypto.randomUUID(),
    joinedAt: Date.now(),
    peer: null,
    queue: new InputQueue(),
    stream: new ClientStream(),
    banked: 0,
    roster: { id: 0, name: 'Settler', level: 1, prestige: 0, bot: false, loadout: [] },
    rtt: [],
    tcpRtt: null,
    windowStart: 0,
    windowCount: 0,
    strikes: 0,
    malformed: 0,
    flags: 0,
    xpFlushed: 0,
    xpFlushIndex: 0,
    ledger: true,
    msgsIn: 0,
  }
}

const purse = async (id: string): Promise<{ purse: number; xp: number }> =>
  (await t.db
    .prepare('SELECT purse, xp FROM profiles WHERE account_id = ?')
    .bind(id)
    .first<{ purse: number; xp: number }>()) ?? {
    purse: -1,
    xp: -1,
  }

describe('Frontier settlement (D1)', () => {
  it('a deposit credits the wallet once, with commission and bank XP, even when replayed', async () => {
    const acct = await account()
    const s = session(acct)
    await sessionStartStatement(t.env, 'lobby:0', s).run()
    const before = await purse(acct)
    const d: SettledDeposit = {
      playerId: 0,
      accountId: acct,
      seq: 1,
      amount: 600,
      commission: 60,
      xp: 60,
      bot: false,
      sessionId: s.sessionId,
    }
    await t.db.batch(depositStatements(t.env, 'lobby:0', d))
    await t.db.batch(depositStatements(t.env, 'lobby:0', d))
    const after = await purse(acct)
    expect(after.purse - before.purse).toBe(660)
    expect(after.xp - before.xp).toBe(60)
    const rows = await t.db
      .prepare('SELECT COUNT(*) n FROM ffa_deposits WHERE account_id = ?')
      .bind(acct)
      .first<{ n: number }>()
    expect(rows?.n).toBe(1)
    const sess = await t.db
      .prepare('SELECT banked FROM ffa_sessions WHERE id = ?')
      .bind(s.sessionId)
      .first<{ banked: number }>()
    expect(sess?.banked).toBe(660)
  })

  it('a small deposit has no commission row', async () => {
    const acct = await account()
    const s = session(acct)
    const before = await purse(acct)
    await t.db.batch(
      depositStatements(t.env, 'lobby:1', {
        playerId: 0,
        accountId: acct,
        seq: 1,
        amount: 40,
        commission: 0,
        xp: 4,
        bot: false,
        sessionId: s.sessionId,
      }),
    )
    expect((await purse(acct)).purse - before.purse).toBe(40)
  })

  it('XP flushes are XP-only ledger entries and session stats are absolute', async () => {
    const acct = await account()
    const s = session(acct)
    await sessionStartStatement(t.env, 'lobby:0', s).run()
    const p = newPlayer(0, { accountId: acct, name: 'x', level: 1, prestige: 0, bot: false })
    p.stats.xp = 70
    p.stats.kills = 2
    const before = await purse(acct)
    const first = xpFlushStatements(t.env, { session: s, player: p, flushIndex: 0, leftAt: null })
    await t.db.batch(first.statements)
    s.xpFlushed += first.xp
    p.stats.xp = 100
    const second = xpFlushStatements(t.env, {
      session: s,
      player: p,
      flushIndex: 1,
      leftAt: Date.now(),
    })
    await t.db.batch(second.statements)
    const after = await purse(acct)
    expect(second.xp).toBe(30)
    expect(after.xp - before.xp).toBe(100)
    expect(after.purse).toBe(before.purse)
    const row = await t.db
      .prepare('SELECT kills, xp, left_at FROM ffa_sessions WHERE id = ?')
      .bind(s.sessionId)
      .first<{ kills: number; xp: number; left_at: number | null }>()
    expect(row?.kills).toBe(2)
    expect(row?.left_at).not.toBeNull()
  })

  it('lobby stats accumulate per day', async () => {
    const delta = {
      occupiedSeconds: 60,
      peakHumans: 3,
      messagesIn: 300,
      minted: 50,
      burned: 20,
      deposited: 100,
      kills: 4,
    }
    await lobbyStatsStatement(t.env, 'lobby:test', delta).run()
    await lobbyStatsStatement(t.env, 'lobby:test', { ...delta, peakHumans: 5 }).run()
    const row = await t.db
      .prepare(
        "SELECT occupied_seconds o, peak_humans p FROM ffa_lobby_stats WHERE lobby_id = 'lobby:test'",
      )
      .first<{ o: number; p: number }>()
    expect(row).toEqual({ o: 120, p: 5 })
  })
})
