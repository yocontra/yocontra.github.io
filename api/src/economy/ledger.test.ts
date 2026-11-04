import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { DEFAULT_LOADOUT, STARTER_ITEMS } from '../../../src/experiments/out-west/data/catalog.ts'
import {
  levelRewards,
  START_PURSE,
  xpForLevel,
} from '../../../src/experiments/out-west/data/progression.ts'
import { auditLedger } from './audit.ts'
import { gauntletClearStatements } from './gauntlet.ts'
import { isOverdraft, type LedgerEntry, ledgerStatements } from './ledger.ts'
import { createProfile, createProfileStatements, getProfile, ownedItems } from './profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from './testing/d1.ts'

let t: TestDb

beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

async function newPlayer(name = 'Test'): Promise<string> {
  const id = freshId()
  await insertAccount(t.db, id, name)
  await createProfile(t.env, id, name)
  return id
}

const apply = (key: string, entries: LedgerEntry[]) =>
  t.db.batch(ledgerStatements(t.env, key, entries))

async function rows(accountId: string) {
  const { results } = await t.db
    .prepare('SELECT * FROM ledger WHERE account_id = ? ORDER BY id')
    .bind(accountId)
    .all<{ kind: string; delta: number; xp: number; balance_after: number; idem_key: string }>()
  return results
}

describe('createProfile', () => {
  it('grants $250, the eight starters and the default loadout', async () => {
    const id = await newPlayer('Doc')
    const p = await getProfile(t.env, id)
    expect(p).toEqual({
      accountId: id,
      name: 'Doc',
      purse: START_PURSE,
      xp: 0,
      level: 1,
      prestige: 0,
      loadout: { ...DEFAULT_LOADOUT },
    })
    expect(new Set(await ownedItems(t.env, id))).toEqual(new Set(STARTER_ITEMS))
    expect(await rows(id)).toHaveLength(1)
  })

  it('is idempotent: a second call never grants twice', async () => {
    const id = await newPlayer()
    await createProfile(t.env, id, 'Test')
    await t.db.batch(createProfileStatements(t.env, id))
    expect((await getProfile(t.env, id))?.purse).toBe(START_PURSE)
    expect(await rows(id)).toHaveLength(1)
  })

  it('fails without an account row (foreign key)', async () => {
    await expect(createProfile(t.env, freshId('ghost'), 'Nobody')).rejects.toThrow()
  })
})

describe('ledgerStatements', () => {
  it('credits purse and writes balance_after', async () => {
    const id = await newPlayer()
    await apply('k:credit', [{ accountId: id, kind: 'duel_win', amount: 120, ref: 'm1' }])
    expect((await getProfile(t.env, id))?.purse).toBe(370)
    const last = (await rows(id)).at(-1)
    expect(last).toMatchObject({ kind: 'duel_win', delta: 120, balance_after: 370 })
  })

  it('a duplicate idem key is a no-op, not a double credit and not an error', async () => {
    const id = await newPlayer()
    const entries: LedgerEntry[] = [{ accountId: id, kind: 'duel_win', amount: 50, xp: 100 }]
    await apply(`dup:${id}`, entries)
    await apply(`dup:${id}`, entries)
    await apply(`dup:${id}`, entries)
    const p = await getProfile(t.env, id)
    expect(p?.purse).toBe(300)
    expect(p?.xp).toBe(100)
    expect(await rows(id)).toHaveLength(2)
  })

  it('a replay of a debit is a no-op even when the purse could no longer cover it', async () => {
    const id = await newPlayer()
    await apply(`spend:${id}`, [{ accountId: id, kind: 'store_purchase', amount: -250 }])
    expect((await getProfile(t.env, id))?.purse).toBe(0)
    await apply(`spend:${id}`, [{ accountId: id, kind: 'store_purchase', amount: -250 }])
    expect((await getProfile(t.env, id))?.purse).toBe(0)
  })

  it('an overdraft fails the whole batch, including the caller rows', async () => {
    const a = await newPlayer()
    const b = await newPlayer()
    await t.db.prepare('CREATE TABLE IF NOT EXISTS side_rows (id TEXT PRIMARY KEY)').run()
    const statements = [
      t.db.prepare('INSERT INTO side_rows (id) VALUES (?)').bind(`match:${a}`),
      ...ledgerStatements(t.env, `match:${a}`, [
        { accountId: a, kind: 'duel_win', amount: 500 },
        { accountId: b, kind: 'duel_loss', amount: -251 },
      ]),
    ]
    let caught: unknown = null
    try {
      await t.db.batch(statements)
    } catch (err) {
      caught = err
    }
    expect(isOverdraft(caught)).toBe(true)
    expect((await getProfile(t.env, a))?.purse).toBe(250)
    expect((await getProfile(t.env, b))?.purse).toBe(250)
    expect(await rows(a)).toHaveLength(1)
    const side = await t.db.prepare('SELECT COUNT(*) AS n FROM side_rows WHERE id = ?')
    expect((await side.bind(`match:${a}`).first<{ n: number }>())?.n).toBe(0)
  })

  it('applies several entries for several accounts in order', async () => {
    const a = await newPlayer()
    const b = await newPlayer()
    await apply(`multi:${a}`, [
      { accountId: a, kind: 'duel_win', amount: 60, xp: 100 },
      { accountId: b, kind: 'duel_loss', amount: -10, xp: 40 },
      { accountId: a, kind: 'duel_win', amount: 50, ref: 'streak' },
    ])
    expect((await getProfile(t.env, a))?.purse).toBe(360)
    expect((await getProfile(t.env, b))?.purse).toBe(240)
    expect((await rows(a)).map((r) => r.balance_after)).toEqual([250, 310, 360])
  })

  it('xp-only entries are allowed; empty entries are skipped', async () => {
    const id = await newPlayer()
    await apply(`xp:${id}`, [
      { accountId: id, kind: 'ffa_kill_mint', amount: 0, xp: 30 },
      { accountId: id, kind: 'ffa_kill_mint', amount: 0 },
    ])
    expect((await getProfile(t.env, id))?.xp).toBe(30)
    expect(await rows(id)).toHaveLength(2)
  })

  it('levels up and pays $25 × each new level as level_reward rows', async () => {
    const id = await newPlayer()
    // From 0 XP straight to L5 (1,080): rewards for L2..L5.
    await apply(`lvl:${id}`, [{ accountId: id, kind: 'admin_adjust', amount: 0, xp: 1080 }])
    const p = await getProfile(t.env, id)
    expect(p?.level).toBe(5)
    expect(p?.purse).toBe(250 + levelRewards(1, 5))
    const reward = (await rows(id)).find((r) => r.kind === 'level_reward')
    expect(reward).toMatchObject({ delta: 350, balance_after: 600 })
    // Replaying the same key neither re-levels nor re-pays.
    await apply(`lvl:${id}`, [{ accountId: id, kind: 'admin_adjust', amount: 0, xp: 1080 }])
    expect((await getProfile(t.env, id))?.purse).toBe(600)
  })

  it('caps at L50', async () => {
    const id = await newPlayer()
    await apply(`cap:${id}`, [
      { accountId: id, kind: 'admin_adjust', amount: 0, xp: xpForLevel(50) + 99_999 },
    ])
    const p = await getProfile(t.env, id)
    expect(p?.level).toBe(50)
    expect(p?.purse).toBe(250 + levelRewards(1, 50))
  })

  it('rejects bad input before touching the database', () => {
    expect(() =>
      ledgerStatements(t.env, 'x', [{ accountId: 'a', kind: 'duel_win', amount: 1.5 }]),
    ).toThrow(RangeError)
    expect(() =>
      ledgerStatements(t.env, 'x', [{ accountId: 'a', kind: 'duel_win', amount: 1, xp: -1 }]),
    ).toThrow(RangeError)
    expect(() =>
      ledgerStatements(t.env, '', [{ accountId: 'a', kind: 'duel_win', amount: 1 }]),
    ).toThrow(RangeError)
    expect(() =>
      ledgerStatements(t.env, 'x', [{ accountId: 'a', kind: 'bogus' as 'duel_win', amount: 1 }]),
    ).toThrow(RangeError)
  })

  it('a missing profile aborts the batch instead of losing money', async () => {
    const id = freshId()
    await insertAccount(t.db, id, 'NoProfile')
    await expect(
      apply(`np:${id}`, [{ accountId: id, kind: 'duel_win', amount: 5 }]),
    ).rejects.toThrow()
  })

  it('concurrent replays of one key credit exactly once', async () => {
    const id = await newPlayer()
    const entries: LedgerEntry[] = [{ accountId: id, kind: 'ffa_deposit', amount: 700 }]
    await Promise.all(Array.from({ length: 8 }, () => apply(`race:${id}`, entries)))
    expect((await getProfile(t.env, id))?.purse).toBe(950)
  })
})

describe('gauntletClearStatements', () => {
  it('pays a first clear once per account, then repeat XP (10 + 2·level) capped at 600 a day', async () => {
    const id = await newPlayer()
    await t.db.batch(await gauntletClearStatements(t.env, id, 2, 'run1'))
    let p = await getProfile(t.env, id)
    expect(p?.xp).toBe(70)
    expect(p?.purse).toBe(260)
    // Same outlaw on another run: repeat XP only.
    await t.db.batch(await gauntletClearStatements(t.env, id, 2, 'run2'))
    p = await getProfile(t.env, id)
    expect(p?.xp).toBe(84)
    expect(p?.purse).toBe(260)
    for (let i = 3; i < 60; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential runs
      const s = await gauntletClearStatements(t.env, id, 2, `run${i}`)
      if (s.length > 0) {
        await t.db.batch(s)
      }
    }
    // 14 XP a repeat on outlaw 3: 42 of them fit under 600
    expect((await getProfile(t.env, id))?.xp).toBe(70 + 42 * 14)
  })

  it('the full gauntlet grants every first clear and Hardin’s Pair', async () => {
    const id = await newPlayer()
    for (let level = 0; level < 17; level++) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential wins
      await t.db.batch(await gauntletClearStatements(t.env, id, level, 'full'))
    }
    const p = await getProfile(t.env, id)
    expect(p?.xp).toBe(2720)
    expect(p?.level).toBe(7)
    expect(await ownedItems(t.env, id)).toContain('gun.hardins-pair')
    expect((await auditLedger(t.env)).mismatches).toEqual([])
    // seventeen settled clears against a real D1: slow on CI runners
  }, 20_000)

  it('returns nothing for a guest or a bad level', async () => {
    expect(await gauntletClearStatements(t.env, 'nobody', 0, 'r')).toEqual([])
    const id = await newPlayer()
    expect(await gauntletClearStatements(t.env, id, 17, 'r')).toEqual([])
  })
})

describe('auditLedger', () => {
  it('flags a purse that disagrees with its ledger', async () => {
    const id = await newPlayer()
    await apply(`aud:${id}`, [{ accountId: id, kind: 'duel_win', amount: 40, xp: 500 }])
    expect((await auditLedger(t.env)).mismatches.filter((m) => m.accountId === id)).toEqual([])
    await t.db.prepare('UPDATE profiles SET purse = purse + 7 WHERE account_id = ?').bind(id).run()
    const report = await auditLedger(t.env)
    expect(report.mismatches).toContainEqual({
      accountId: id,
      purse: 290 + levelRewards(1, 3) + 7,
      ledgerSum: 290 + levelRewards(1, 3),
      lastBalance: 290 + levelRewards(1, 3),
    })
  })
})
