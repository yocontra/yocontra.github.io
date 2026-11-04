/**
 * The solo meta-game routes (meta-game stream): /progress (migrate, claim, legend), the store's
 * solo-level gates, and the Daily Outlaw (spec, tickets, tries, the settle, the board).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { BuyResponse, MeResponse } from '../../../src/experiments/out-west/contract/economy.ts'
import type {
  ClaimResponse,
  DailyBoardResponse,
  DailyResponse,
  MigrateResponse,
  ProgressResponse,
} from '../../../src/experiments/out-west/contract/meta.ts'
import type { RankedSessionResponse } from '../../../src/experiments/out-west/contract/ranked.ts'
import {
  DAILY_ATTEMPTS,
  DAILY_MODIFIERS,
  dailySpec,
  dayKey,
  isDayKey,
} from '../../../src/experiments/out-west/data/daily.ts'
import { OUTLAWS } from '../../../src/experiments/out-west/data/outlaws.ts'
import { signAccessToken } from '../auth/token.ts'
import { dailyRank } from '../daily/board.ts'
import { settleDaily } from '../daily/settle.ts'
import { dailyTuning } from '../daily/tuning.ts'
import { auditLedger } from '../economy/audit.ts'
import { FULL_CLEAR_MASK } from '../economy/gauntlet.ts'
import { ledgerStatements } from '../economy/ledger.ts'
import { medalStatements } from '../economy/medals.ts'
import { createProfile, getProfileDetail, ownedItems } from '../economy/profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from '../economy/testing/d1.ts'
import type { Env } from '../env.ts'
import { makeDailyRoutes } from './daily.ts'
import { meRoutes } from './me.ts'
import { progressRoutes, sanitizeClaim } from './progress.ts'
import { storeRoutes } from './store.ts'

let t: TestDb
let env: Env
let turnstileOk = true
const daily = makeDailyRoutes(() => Promise.resolve(turnstileOk))
let sessionSeq = 0

beforeAll(async () => {
  t = await testDb()
  env = {
    ...t.env,
    DAILY_SESSIONS: {
      newUniqueId: () => ({ toString: () => (++sessionSeq).toString(16).padStart(64, '0') }),
    },
  } as unknown as Env
})
afterAll(async () => {
  await t.dispose()
})

const ctx = {} as ExecutionContext
const ORIGIN = 'http://localhost:4343'

async function call(
  method: string,
  path: string,
  opts: { as?: string; body?: unknown; ip?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, 'http://localhost:8822')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN }
  if (opts.ip) {
    headers['CF-Connecting-IP'] = opts.ip
  }
  if (opts.as) {
    const { token } = await signAccessToken(env.AUTH_SECRET, {
      accountId: opts.as,
      name: 'Tester',
      sid: 'test-session',
      platform: 'web',
      authTime: Date.now(),
    })
    headers.Authorization = `Bearer ${token}`
  }
  const init: RequestInit = { method, headers }
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
  }
  const request = new Request(url, init)
  const response =
    (await progressRoutes(request, env, url, ctx)) ??
    (await daily(request, env, url, ctx)) ??
    (await meRoutes(request, env, url, ctx)) ??
    (await storeRoutes(request, env, url, ctx))
  if (!response) {
    return { status: 0, body: null }
  }
  return { status: response.status, body: await response.json() }
}

async function player(name = 'Tester'): Promise<string> {
  const id = freshId()
  await insertAccount(t.db, id, name)
  await createProfile(env, id, name)
  return id
}

const allGold = {
  marks: Array.from({ length: 17 }, () => ({ tier: 3, challenge: true })),
  clears: FULL_CLEAR_MASK,
}

describe('POST /progress/migrate', () => {
  it('needs auth', async () => {
    expect((await call('POST', '/progress/migrate', { body: { claim: allGold } })).status).toBe(401)
  })

  it('grants the guest purse once, capped at 2,000 XP and $750, kept off Most Wanted', async () => {
    const id = await player()
    const r = await call('POST', '/progress/migrate', { as: id, body: { claim: allGold } })
    expect(r.status).toBe(200)
    const m = r.body as MigrateResponse
    expect(m.xp).toBe(2000)
    expect(m.cash).toBe(750)
    expect(m.claimed.xp).toBe(5695)
    // $250 start + $750 + level rewards for the XP (L1 → L6: $25 × (2+3+4+5+6))
    expect(m.purse).toBe(250 + 750 + 500)
    const again = await call('POST', '/progress/migrate', { as: id, body: { claim: allGold } })
    expect(again.status).toBe(409)
    const p = await getProfileDetail(env, id)
    expect(p?.purse).toBe(m.purse)
    expect(p?.soloXp).toBe(2000)
    const board = await t.db
      .prepare('SELECT earned FROM earnings_monthly WHERE account_id = ?')
      .bind(id)
      .first<{ earned: number }>()
    // only the level rewards count as earnings, never the migrated dollars
    expect(board?.earned ?? 0).toBe(500)
    expect((await auditLedger(env)).mismatches).toEqual([])
  })

  it('two at once: exactly one wins', async () => {
    const id = await player()
    const both = await Promise.all([
      call('POST', '/progress/migrate', { as: id, body: { claim: allGold } }),
      call('POST', '/progress/migrate', { as: id, body: { claim: allGold } }),
    ])
    expect(both.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409])
    const rows = await t.db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE account_id = ? AND kind = 'guest_migration'")
      .bind(id)
      .first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it('rejects junk, re-prices what it reads, and an empty purse still uses the one migration', async () => {
    const id = await player()
    expect(
      (await call('POST', '/progress/migrate', { as: id, body: { claim: 'lots' } })).status,
    ).toBe(400)
    expect(
      (
        await call('POST', '/progress/migrate', {
          as: id,
          body: { claim: { marks: Array.from({ length: 40 }, () => ({ tier: 3 })), clears: 0 } },
        })
      ).status,
    ).toBe(400)
    // a forged XP figure is ignored: only marks and clears are read
    const r = await call('POST', '/progress/migrate', {
      as: id,
      body: { claim: { marks: [], clears: 0, xp: 1e9, cash: 1e9 } },
    })
    expect((r.body as MigrateResponse).xp).toBe(0)
    expect(
      (await call('POST', '/progress/migrate', { as: id, body: { claim: allGold } })).status,
    ).toBe(409)
  })

  it('the database refuses an oversized migration even if the Worker were wrong', async () => {
    const id = await player()
    const big = ledgerStatements(env, `forged:${id}`, [
      { accountId: id, kind: 'guest_migration', amount: 5000, xp: 0 },
    ])
    await expect(t.db.batch(big)).rejects.toThrow()
  })

  it('sanitizeClaim clamps tiers and masks the clears', () => {
    expect(sanitizeClaim({ marks: [{ tier: 7, challenge: 'yes' }], clears: 2 ** 30 + 1 })).toEqual({
      marks: [{ tier: 3, challenge: false }],
      clears: 1,
    })
    expect(sanitizeClaim(null)).toBeNull()
  })
})

describe('GET /progress and POST /progress/claim', () => {
  it('shows server marks, and a hat claim pays after a recorded ranked win', async () => {
    const id = await player()
    await t.db.batch(
      await medalStatements(env, {
        accountId: id,
        level: 1,
        runId: 'run-hat',
        ev: { reactionMs: 230, fakesSeen: 0, firstTry: true, clean: true },
      }),
    )
    const before = (await call('GET', '/progress', { as: id })).body as ProgressResponse
    expect(before.marks).toHaveLength(17)
    expect(before.marks[1]?.tier).toBe(3)
    expect(before.marks[1]?.challenge).toBe(false)
    expect(before.migration).toBeNull()
    const bad = await call('POST', '/progress/claim', {
      as: id,
      body: { challengeId: 'ch.2.hat', runId: 'someone-elses-run' },
    })
    expect(bad.status).toBe(403)
    const ok = await call('POST', '/progress/claim', {
      as: id,
      body: { challengeId: 'ch.2.hat', runId: 'run-hat' },
    })
    expect(ok.status).toBe(200)
    expect((ok.body as ClaimResponse).xp).toBe(50)
    const twice = await call('POST', '/progress/claim', {
      as: id,
      body: { challengeId: 'ch.2.hat', runId: 'run-hat' },
    })
    expect(twice.status).toBe(409)
    const server = await call('POST', '/progress/claim', {
      as: id,
      body: { challengeId: 'ch.1.steady', runId: 'run-hat' },
    })
    expect(server.status).toBe(400)
  })
})

describe('POST /progress/legend', () => {
  it('needs a full ranked clear, then grants by depth', async () => {
    const id = await player()
    expect((await call('POST', '/progress/legend', { as: id, body: { beaten: 9 } })).status).toBe(
      403,
    )
    await t.db
      .prepare('UPDATE profiles SET gauntlet_clears = ? WHERE account_id = ?')
      .bind(FULL_CLEAR_MASK, id)
      .run()
    expect((await call('POST', '/progress/legend', { as: id, body: { beaten: 99 } })).status).toBe(
      400,
    )
    const six = (await call('POST', '/progress/legend', { as: id, body: { beaten: 6 } }))
      .body as ProgressResponse
    expect(six.rewards).toEqual(['spurs.legend-rowels'])
    await call('POST', '/progress/legend', { as: id, body: { beaten: 9 } })
    expect(await ownedItems(env, id)).toContain('frame.legend')
  })
})

describe('the Outfitter with solo levels', () => {
  it('GET /me reports the store level, and POST /store/buy honours it', async () => {
    const id = await player()
    // L5 earned entirely in single player (1,080 solo XP) shops as L15
    await t.db.batch(
      ledgerStatements(env, `solo:${id}`, [
        { accountId: id, kind: 'medal', amount: 7700, xp: 1080 },
      ]),
    )
    const me = (await call('GET', '/me', { as: id })).body as MeResponse
    expect(me.level).toBe(5)
    expect(me.storeLevel).toBe(15)
    // Engraved Ivory is gated at L15
    const buy = await call('POST', '/store/buy', { as: id, body: { itemId: 'gun.engraved-ivory' } })
    expect(buy.status).toBe(200)
    expect((buy.body as BuyResponse).owned).toContain('gun.engraved-ivory')
    // Buntline at L20 is still out of reach
    const no = await call('POST', '/store/buy', { as: id, body: { itemId: 'gun.buntline' } })
    expect(no.status).toBe(403)
  })

  it('PvP XP alone does not lower the gates', async () => {
    const id = await player()
    await t.db.batch(
      ledgerStatements(env, `pvp:${id}`, [
        { accountId: id, kind: 'duel_win', amount: 9000, xp: 1080 },
      ]),
    )
    const me = (await call('GET', '/me', { as: id })).body as MeResponse
    expect(me.storeLevel).toBe(5)
    const buy = await call('POST', '/store/buy', { as: id, body: { itemId: 'gun.engraved-ivory' } })
    expect(buy.status).toBe(403)
  })

  it('prestige resets solo XP with the level', async () => {
    const id = await player()
    await t.db
      .prepare('UPDATE profiles SET level = 50, xp = 101430, solo_xp = 5000 WHERE account_id = ?')
      .bind(id)
      .run()
    const r = await call('POST', '/me/prestige', { as: id })
    expect(r.status).toBe(200)
    expect((await getProfileDetail(env, id))?.soloXp).toBe(0)
  })
})

describe('the daily spec', () => {
  it('is the same for everyone, rotates modifiers, never the tutorial pair or the specials', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const day = dayKey(Date.UTC(2026, 10, 1) + i * 86_400_000)
      const a = dailySpec(day)
      expect(dailySpec(day)).toEqual(a)
      expect(a.outlaw).toBeGreaterThanOrEqual(2)
      expect(a.outlaw).toBeLessThanOrEqual(14)
      expect(OUTLAWS[a.outlaw]).toBeDefined()
      expect(a.modifiers.length).toBeGreaterThanOrEqual(1)
      expect(a.fakes).toBe(a.modifiers.includes('double-fakes') ? 2 : a.fakes)
      // a hand is slower to read than a bell: no-bell days draw at least 370
      expect(a.drawMs >= 370 || !a.modifiers.includes('no-bell')).toBe(true)
      expect(a.cues).not.toContain('twitch')
      for (const m of a.modifiers) {
        seen.add(m)
      }
      expect(dailyTuning(a).targets[0]?.drawMs).toBe(a.drawMs)
    }
    expect(seen).toEqual(new Set<string>(DAILY_MODIFIERS))
  })

  it('day keys are validated', () => {
    expect(isDayKey('2026-11-03')).toBe(true)
    expect(isDayKey('2026-02-30')).toBe(false)
    expect(isDayKey('2026-11-3')).toBe(false)
    expect(isDayKey(42)).toBe(false)
  })
})

describe('the Daily Outlaw routes', () => {
  it('GET /daily works signed out', async () => {
    const r = await call('GET', '/daily', { ip: '203.0.113.1' })
    const d = r.body as DailyResponse
    expect(r.status).toBe(200)
    expect(d.spec.day).toBe(dayKey())
    expect(d.maxTries).toBe(DAILY_ATTEMPTS)
    expect(d.tries).toBe(0)
  })

  it('a ticket needs Turnstile', async () => {
    turnstileOk = false
    const r = await call('POST', '/daily/sessions', { body: { turnstileToken: 'x' } })
    turnstileOk = true
    expect(r.status).toBe(403)
  })

  it('three tries a day per account, then 429; another account is unaffected', async () => {
    const id = await player()
    for (let i = 0; i < DAILY_ATTEMPTS; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: tries in order
      const r = await call('POST', '/daily/sessions', { as: id, body: { turnstileToken: 'x' } })
      expect(r.status).toBe(201)
      expect((r.body as RankedSessionResponse).wsUrl).toContain('/daily/sessions/')
    }
    const fourth = await call('POST', '/daily/sessions', { as: id, body: { turnstileToken: 'x' } })
    expect(fourth.status).toBe(429)
    const other = await player()
    expect(
      (await call('POST', '/daily/sessions', { as: other, body: { turnstileToken: 'x' } })).status,
    ).toBe(201)
    const d = (await call('GET', '/daily', { as: id })).body as DailyResponse
    expect(d.tries).toBe(DAILY_ATTEMPTS)
  })

  it('guests are counted per network, separately from accounts', async () => {
    const ip = '198.51.100.7'
    const tries = await Promise.all(
      Array.from({ length: DAILY_ATTEMPTS + 2 }, () =>
        call('POST', '/daily/sessions', { ip, body: { turnstileToken: 'x' } }),
      ),
    )
    expect(tries.filter((r) => r.status === 201)).toHaveLength(DAILY_ATTEMPTS)
    expect(tries.filter((r) => r.status === 429)).toHaveLength(2)
  })

  it('closes when the month is over budget', async () => {
    const month = new Date().toISOString().slice(0, 7)
    await t.db
      .prepare("INSERT INTO usage (month, metric, amount) VALUES (?, 'duel_seconds', 10000000)")
      .bind(month)
      .run()
    const id = await player()
    const r = await call('POST', '/daily/sessions', { as: id, body: { turnstileToken: 'x' } })
    await t.db.prepare("DELETE FROM usage WHERE metric = 'duel_seconds'").run()
    expect(r.status).toBe(503)
  })
})

describe('settling a daily attempt', () => {
  async function ticket(account: string | null, day = dayKey()): Promise<string> {
    const id = freshId('daily')
    await t.db
      .prepare(
        "INSERT INTO daily_runs (id, day, account_id, client_hash, created_at) VALUES (?, ?, ?, 'h', ?)",
      )
      .bind(id, day, account, Date.now())
      .run()
    return id
  }

  it('pays a win once a day, ranks it, and a second win pays nothing', async () => {
    const day = '2026-01-15'
    const a = await player('Ann')
    const b = await player('Bo')
    const s1 = await settleDaily(env, {
      id: await ticket(a, day),
      day,
      accountId: a,
      outcome: 'win',
      reactionMs: 240.4,
    })
    expect(s1).toEqual({ cash: 50, xp: 75, rank: 1 })
    const s2 = await settleDaily(env, {
      id: await ticket(b, day),
      day,
      accountId: b,
      outcome: 'win',
      reactionMs: 210,
    })
    expect(s2.rank).toBe(1)
    expect(await dailyRank(env, day, a)).toBe(2)
    const again = await settleDaily(env, {
      id: await ticket(a, day),
      day,
      accountId: a,
      outcome: 'win',
      reactionMs: 200,
    })
    expect(again.cash).toBe(0)
    expect(again.rank).toBe(1)
    const board = (await call('GET', `/daily/board?day=${day}`, { as: b }))
      .body as DailyBoardResponse
    expect(board.rows.map((r) => [r.rank, r.name, r.ms])).toEqual([
      [1, 'Ann', 200],
      [2, 'Bo', 210],
    ])
    expect(board.you).toEqual({ rank: 2, ms: 210 })
    expect((await auditLedger(env)).mismatches).toEqual([])
  })

  it('a loss or a guest win pays nothing; a settled ticket cannot be settled again', async () => {
    const day = '2026-01-16'
    const a = await player()
    const id = await ticket(a, day)
    expect(
      await settleDaily(env, { id, day, accountId: a, outcome: 'loss', reactionMs: null }),
    ).toEqual({
      cash: 0,
      xp: 0,
      rank: null,
    })
    // the same ticket replayed as a win: the row stays a loss
    await settleDaily(env, { id, day, accountId: a, outcome: 'win', reactionMs: 150 })
    const row = await t.db
      .prepare('SELECT outcome FROM daily_runs WHERE id = ?')
      .bind(id)
      .first<{ outcome: string }>()
    expect(row).toEqual({ outcome: 'loss' })
    const guest = await settleDaily(env, {
      id: await ticket(null, day),
      day,
      accountId: null,
      outcome: 'win',
      reactionMs: 200,
    })
    expect(guest).toEqual({ cash: 0, xp: 0, rank: null })
  })

  it('Badlands accounts are off the board', async () => {
    const day = '2026-01-17'
    const a = await player('Shady')
    await t.db.prepare('UPDATE accounts SET flags = 1 WHERE id = ?').bind(a).run()
    await settleDaily(env, {
      id: await ticket(a, day),
      day,
      accountId: a,
      outcome: 'win',
      reactionMs: 150,
    })
    const board = (await call('GET', `/daily/board?day=${day}`)).body as DailyBoardResponse
    expect(board.rows).toEqual([])
  })

  it('seven winning days earn the Black Bandana', async () => {
    const a = await player()
    for (let i = 1; i <= 7; i++) {
      const day = `2026-02-0${i}`
      // biome-ignore lint/performance/noAwaitInLoops: days in order
      await settleDaily(env, {
        id: await ticket(a, day),
        day,
        accountId: a,
        outcome: 'win',
        reactionMs: 300,
      })
      expect((await ownedItems(env, a)).includes('extra.black-bandana')).toBe(i === 7)
    }
  })
})
