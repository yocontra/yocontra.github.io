/**
 * The monthly Most Wanted board, the money sinks (dye, name change, a round for the house), public
 * posters, reports, blocks and the "while you were away" report, against a real local D1 with every
 * migration applied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type {
  DyeResponse,
  MeResponse,
  MostWantedResponse,
} from '../../../src/experiments/out-west/contract/economy.ts'
import type {
  BlocksResponse,
  ChalkboardResponse,
  NameChangeResponse,
  PlayerPoster,
  RoundResponse,
} from '../../../src/experiments/out-west/contract/social.ts'
import { DYE_PRICE_MIN } from '../../../src/experiments/out-west/data/dye.ts'
import { LICENCE_MASK } from '../../../src/experiments/out-west/data/licence.ts'
import {
  HOUSE_ROUND_PRICE,
  MOST_WANTED_FRAME,
  monthOf,
  NAME_CHANGE_PRICE,
  previousMonth,
} from '../../../src/experiments/out-west/data/sinks.ts'
import { isNameOwned } from '../auth/accounts.ts'
import { signAccessToken } from '../auth/token.ts'
import { FLAG_BADLANDS, FLAG_REPORTED } from '../moderation/flags.ts'
import { nameKey } from '../names.ts'
import { meRoutes } from '../routes/me.ts'
import { socialRoutes } from '../routes/social.ts'
import { storeRoutes } from '../routes/store.ts'
import { auditLedger } from './audit.ts'
import { freezeMonth, monthEnd, ROLLOVER_GRACE_MS } from './board.ts'
import { ledgerStatements } from './ledger.ts'
import { createProfile } from './profile.ts'
import { freshId, type TestDb, testDb } from './testing/d1.ts'

let t: TestDb
beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

const ctx = {} as ExecutionContext
let seq = 0

async function call(
  method: string,
  path: string,
  opts: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, 'http://localhost:8799')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.as) {
    const { token } = await signAccessToken(t.env.AUTH_SECRET, {
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
    (await socialRoutes(request, t.env, url, ctx)) ??
    (await meRoutes(request, t.env, url, ctx)) ??
    (await storeRoutes(request, t.env, url, ctx))
  if (!response) {
    return { status: 0, body: null }
  }
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) }
}

/** A signed-up player with a real name key, an optional purse and an optional licence. */
async function player(opts: { purse?: number; licensed?: boolean; name?: string } = {}) {
  const id = freshId('soc')
  seq++
  const name = opts.name ?? `Gunner ${seq} ${id.slice(-4)}`.slice(0, 16)
  await t.db
    .prepare('INSERT INTO accounts (id, name, name_key, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, nameKey(name), Date.now())
    .run()
  await createProfile(t.env, id, name)
  if ((opts.purse ?? 0) > 0) {
    await t.db.batch(
      ledgerStatements(t.env, `seed:${id}`, [
        { accountId: id, kind: 'admin_adjust', amount: opts.purse ?? 0 },
      ]),
    )
  }
  if (opts.licensed) {
    await t.db
      .prepare('UPDATE profiles SET gauntlet_clears = ? WHERE account_id = ?')
      .bind(LICENCE_MASK, id)
      .run()
  }
  return { id, name }
}

const purseOf = async (id: string): Promise<number> =>
  (
    await t.db.prepare('SELECT purse FROM profiles WHERE account_id = ?').bind(id).first<{
      purse: number
    }>()
  )?.purse ?? -1

async function earn(id: string, kind: 'duel_win' | 'ffa_deposit', amount: number, key: string) {
  await t.db.batch(ledgerStatements(t.env, key, [{ accountId: id, kind, amount }]))
}

describe('Most Wanted board', () => {
  it('ranks earnings credits only, never purchases, sinks or the start grant', async () => {
    const month = monthOf(Date.now())
    const a = await player({ purse: 50_000 })
    await earn(a.id, 'duel_win', 900_000, `mw:a:${a.id}`)
    await earn(a.id, 'ffa_deposit', 100_000, `mw:a2:${a.id}`)
    // A purchase and a loss don't reduce or add to earnings.
    await t.db.batch(
      ledgerStatements(t.env, `mw:buy:${a.id}`, [
        { accountId: a.id, kind: 'store_purchase', amount: -300 },
        { accountId: a.id, kind: 'duel_loss', amount: -10 },
      ]),
    )
    const b = await player()
    await earn(b.id, 'duel_win', 800_000, `mw:b:${b.id}`)
    const { body } = await call('GET', `/board/most-wanted?month=${month}`, { as: b.id })
    const board = body as MostWantedResponse
    expect(board.month).toBe(month)
    expect(board.final).toBe(false)
    expect(board.rows[0]).toMatchObject({ name: a.name, earned: 1_000_000, rank: 1 })
    expect(board.rows[1]).toMatchObject({ name: b.name, earned: 800_000, rank: 2 })
    expect(board.you).toEqual({ rank: 2, earned: 800_000 })
    // admin_adjust (the seed) and start_grant never count.
    expect(board.rows.some((r) => r.earned === 50_000 + 1_000_000)).toBe(false)
  })

  it('a replayed ledger batch adds nothing to the board', async () => {
    const a = await player()
    await earn(a.id, 'duel_win', 700_001, `mw:replay:${a.id}`)
    await earn(a.id, 'duel_win', 700_001, `mw:replay:${a.id}`)
    const row = await t.db
      .prepare('SELECT earned FROM earnings_monthly WHERE account_id = ?')
      .bind(a.id)
      .first<{ earned: number }>()
    expect(row?.earned).toBe(700_001)
  })

  it('level rewards count; XP-only rows add nothing else', async () => {
    const a = await player()
    // 150 XP → level 2 → a $50 level reward, booked inside the ledger.
    await t.db.batch(
      ledgerStatements(t.env, `mw:xp:${a.id}`, [
        { accountId: a.id, kind: 'ffa_kill_mint', amount: 0, xp: 150 },
      ]),
    )
    const row = await t.db
      .prepare('SELECT earned FROM earnings_monthly WHERE account_id = ?')
      .bind(a.id)
      .first<{ earned: number }>()
    expect(row?.earned).toBe(50)
  })

  it('leaves out Badlands and banned accounts, who take no rank', async () => {
    const month = monthOf(Date.now())
    const cheat = await player()
    await earn(cheat.id, 'duel_win', 5_000_000, `mw:cheat:${cheat.id}`)
    await t.db
      .prepare('UPDATE accounts SET flags = ? WHERE id = ?')
      .bind(FLAG_BADLANDS, cheat.id)
      .run()
    const { body } = await call('GET', `/board/most-wanted?month=${month}&limit=50`, {
      as: cheat.id,
    })
    const board = body as MostWantedResponse
    expect(board.rows.some((r) => r.name === cheat.name)).toBe(false)
    expect(board.rows[0]?.rank).toBe(1)
    expect(board.you).toEqual({ rank: null, earned: 5_000_000 })
  })

  it('rolls a month over: frozen top 10, dated frames, idempotent', async () => {
    const month = '2026-01'
    const at = Date.UTC(2026, 0, 15)
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: seeding in a fixed order
      const p = await player()
      ids.push(p.id)
      await t.db
        .prepare(
          'INSERT INTO earnings_monthly (month, account_id, earned, updated_at) VALUES (?, ?, ?, ?)',
        )
        .bind(month, p.id, 1000 * (i + 1), at)
        .run()
    }
    expect(await freezeMonth(t.env, month, monthEnd(month) + ROLLOVER_GRACE_MS - 1)).toBe(false)
    expect(await freezeMonth(t.env, month, monthEnd(month) + ROLLOVER_GRACE_MS)).toBe(true)
    expect(await freezeMonth(t.env, month, monthEnd(month) + ROLLOVER_GRACE_MS + 1)).toBe(false)
    const { results } = await t.db
      .prepare('SELECT rank, account_id FROM most_wanted_winners WHERE month = ? ORDER BY rank')
      .bind(month)
      .all<{ rank: number; account_id: string }>()
    expect(results).toHaveLength(10)
    expect(results[0]?.account_id).toBe(ids[11] ?? '')
    const frames = await t.db
      .prepare('SELECT COUNT(*) AS n FROM inventory WHERE item_id = ? AND account_id IN (?, ?)')
      .bind(MOST_WANTED_FRAME, ids[11] ?? '', ids[0] ?? '')
      .first<{ n: number }>()
    // The top earner got a frame, the 12th didn't.
    expect(frames?.n).toBe(1)
    const { body } = await call(
      'GET',
      `/board/most-wanted?${new URLSearchParams({ month: '2026-02' })}`,
    )
    const board = body as MostWantedResponse
    expect(board.final).toBe(true)
    expect(board.previous.month).toBe('2026-01')
    expect(board.previous.winners).toHaveLength(10)
    expect(board.previous.winners[0]?.earned).toBe(12_000)
  })

  it('a bad month falls back to the current one', async () => {
    const { body } = await call('GET', '/board/most-wanted?month=garbage')
    expect((body as MostWantedResponse).month).toBe(monthOf(Date.now()))
    expect((body as MostWantedResponse).previous.month).toBe(previousMonth(monthOf(Date.now())))
  })
})

describe('POST /store/dye', () => {
  it('dyes an owned item, charges by rarity, and washes out for free', async () => {
    const p = await player({ purse: 5000 })
    const before = await purseOf(p.id)
    const res = await call('POST', '/store/dye', {
      as: p.id,
      body: { itemId: 'hat.battered-brim', dye: 'oxblood' },
    })
    expect(res.status).toBe(200)
    const dyed = res.body as DyeResponse
    // a starter hat costs nothing, so its dye costs the minimum
    expect(dyed.price).toBe(DYE_PRICE_MIN)
    expect(dyed.purse).toBe(before - DYE_PRICE_MIN)
    expect(dyed.dyes).toEqual({ 'hat.battered-brim': 'oxblood' })
    const same = await call('POST', '/store/dye', {
      as: p.id,
      body: { itemId: 'hat.battered-brim', dye: 'oxblood' },
    })
    expect(same.status).toBe(409)
    const wash = await call('POST', '/store/dye', {
      as: p.id,
      body: { itemId: 'hat.battered-brim', dye: 'natural' },
    })
    expect((wash.body as DyeResponse).price).toBe(0)
    expect((wash.body as DyeResponse).dyes).toEqual({})
    expect(await purseOf(p.id)).toBe(before - DYE_PRICE_MIN)
    expect((await auditLedger(t.env)).mismatches).toEqual([])
  })

  it('refuses guns, unowned items and an empty purse', async () => {
    const p = await player()
    const gun = await call('POST', '/store/dye', {
      as: p.id,
      body: { itemId: 'gun.rusty-six', dye: 'coal' },
    })
    expect(gun.status).toBe(400)
    const unowned = await call('POST', '/store/dye', {
      as: p.id,
      body: { itemId: 'hat.sombrero', dye: 'coal' },
    })
    expect(unowned.status).toBe(403)
    await t.db.batch(
      ledgerStatements(t.env, `drain:${p.id}`, [
        { accountId: p.id, kind: 'admin_adjust', amount: -(await purseOf(p.id)) },
      ]),
    )
    const broke = await call('POST', '/store/dye', {
      as: p.id,
      body: { itemId: 'outfit.trail-duds', dye: 'coal' },
    })
    expect(broke.status).toBe(402)
  })

  it('a retried request with the same requestId charges once', async () => {
    const p = await player({ purse: 5000 })
    const before = await purseOf(p.id)
    const body = { itemId: 'outfit.trail-duds', dye: 'indigo', requestId: 'retry-dye-0001' }
    expect((await call('POST', '/store/dye', { as: p.id, body })).status).toBe(200)
    // The client didn't hear back and retries: the dye is already on, so 409, and no new charge.
    const again = await call('POST', '/store/dye', { as: p.id, body })
    expect(again.status).toBe(409)
    expect(await purseOf(p.id)).toBe(before - DYE_PRICE_MIN)
  })
})

describe('POST /me/name', () => {
  it('charges $5,000, holds the old name for you, and enforces the cooldown', async () => {
    const p = await player({ purse: 20_000, name: 'Old Timer' })
    const before = await purseOf(p.id)
    const res = await call('POST', '/me/name', { as: p.id, body: { name: 'New Timer' } })
    expect(res.status).toBe(200)
    const changed = res.body as NameChangeResponse
    expect(changed.name).toBe('New Timer')
    expect(changed.purse).toBe(before - NAME_CHANGE_PRICE)
    // The old name is held: nobody can sign up with it.
    expect(await isNameOwned(t.env, nameKey('Old Timer'))).toBe(true)
    const me = (await call('GET', '/me', { as: p.id })).body as MeResponse
    expect(me.name).toBe('New Timer')
    const again = await call('POST', '/me/name', { as: p.id, body: { name: 'Old Timer' } })
    expect(again.status).toBe(429)
    expect((again.body as { retryAfterS: number }).retryAfterS).toBeGreaterThan(0)
    // After the cooldown, you can take your own held name back.
    await t.db.prepare('UPDATE accounts SET name_changed_at = 1 WHERE id = ?').bind(p.id).run()
    const back = await call('POST', '/me/name', { as: p.id, body: { name: 'old  timer' } })
    expect(back.status).toBe(200)
    expect((await auditLedger(t.env)).mismatches).toEqual([])
  })

  it("refuses someone else's name, a held name, a bad name and an empty purse", async () => {
    const taken = await player({ name: 'Taken Name' })
    const p = await player({ purse: 20_000 })
    expect(
      (await call('POST', '/me/name', { as: p.id, body: { name: 'TAKEN name' } })).status,
    ).toBe(409)
    expect((await call('POST', '/me/name', { as: p.id, body: { name: '!!' } })).status).toBe(400)
    // Somebody else's held old name.
    const q = await player({ purse: 20_000, name: 'Holder' })
    expect(
      (await call('POST', '/me/name', { as: q.id, body: { name: 'Holder Two' } })).status,
    ).toBe(200)
    expect((await call('POST', '/me/name', { as: p.id, body: { name: 'Holder' } })).status).toBe(
      409,
    )
    const broke = await player()
    expect(
      (await call('POST', '/me/name', { as: broke.id, body: { name: 'Rich Someday' } })).status,
    ).toBe(402)
    expect(taken.id).not.toBe('')
  })
})

describe('the saloon', () => {
  it('a round costs $1,000 and puts your name on the chalkboard, once per request', async () => {
    const p = await player({ purse: 3000 })
    const before = await purseOf(p.id)
    const body = { requestId: `round-${p.id}` }
    const res = await call('POST', '/saloon/round', { as: p.id, body })
    expect(res.status).toBe(200)
    expect((res.body as RoundResponse).purse).toBe(before - HOUSE_ROUND_PRICE)
    expect((res.body as RoundResponse).rounds[0]?.name).toBe(p.name)
    await call('POST', '/saloon/round', { as: p.id, body })
    expect(await purseOf(p.id)).toBe(before - HOUSE_ROUND_PRICE)
    const board = (await call('GET', '/saloon/chalkboard')).body as ChalkboardResponse
    expect(board.rounds.filter((r) => r.name === p.name)).toHaveLength(1)
  })

  it("refuses a round you can't pay for", async () => {
    const p = await player()
    await call('POST', '/saloon/round', { as: p.id })
    await call('POST', '/saloon/round', { as: p.id })
    // $250 start grant: neither round could be paid.
    expect(await purseOf(p.id)).toBe(250)
    expect((await call('POST', '/saloon/round', { as: p.id })).status).toBe(402)
  })
})

describe('posters, reports and blocks', () => {
  it('GET /players/:name shows the public poster and hides banned accounts', async () => {
    const p = await player({ licensed: true, name: 'Poster Boy' })
    const res = await call('GET', '/players/poster%20boy')
    expect(res.status).toBe(200)
    const poster = res.body as PlayerPoster
    expect(poster).toMatchObject({
      name: 'Poster Boy',
      level: 1,
      licensed: true,
      blockedByYou: null,
    })
    expect(poster.loadout.hat).toBe('hat.battered-brim')
    await t.db.prepare('UPDATE accounts SET flags = 2 WHERE id = ?').bind(p.id).run()
    expect((await call('GET', '/players/Poster%20Boy')).status).toBe(404)
    expect((await call('GET', '/players/Nobody%20Here')).status).toBe(404)
  })

  it('blocks are private, listed, idempotent and removable', async () => {
    const a = await player()
    const b = await player()
    const added = await call('POST', '/blocks', { as: a.id, body: { name: b.name } })
    expect((added.body as BlocksResponse).blocked).toEqual([b.name])
    await call('POST', '/blocks', { as: a.id, body: { name: b.name } })
    expect(((await call('GET', '/blocks', { as: a.id })).body as BlocksResponse).blocked).toEqual([
      b.name,
    ])
    const poster = (await call('GET', `/players/${encodeURIComponent(b.name)}`, { as: a.id }))
      .body as PlayerPoster
    expect(poster.blockedByYou).toBe(true)
    expect((await call('POST', '/blocks', { as: a.id, body: { name: a.name } })).status).toBe(400)
    const removed = await call('DELETE', `/blocks/${encodeURIComponent(b.name)}`, { as: a.id })
    expect((removed.body as BlocksResponse).blocked).toEqual([])
  })

  it('reports from licensed players mark, then send a cheat to the Badlands', async () => {
    const target = await player()
    const flags = async (): Promise<number> =>
      (
        await t.db.prepare('SELECT flags FROM accounts WHERE id = ?').bind(target.id).first<{
          flags: number
        }>()
      )?.flags ?? -1
    // Unlicensed reporters don't count.
    for (let i = 0; i < 6; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: reports in order
      const r = await player()
      await call('POST', '/reports', { as: r.id, body: { name: target.name, reason: 'cheating' } })
    }
    expect(await flags()).toBe(0)
    const reporters: { id: string; name: string }[] = []
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: reports in order
      reporters.push(await player({ licensed: true }))
    }
    for (const [i, r] of reporters.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: thresholds are crossed in order
      const res = await call('POST', '/reports', {
        as: r.id,
        body: { name: target.name, reason: 'cheating', block: i === 0 },
      })
      expect(res.status).toBe(200)
      // One reporter reporting again the same day changes nothing.
      await call('POST', '/reports', { as: r.id, body: { name: target.name, reason: 'cheating' } })
      seen.push(await flags())
    }
    // 3 licensed reporters mark the account; 5 reports of cheating send it to the Badlands.
    expect(seen).toEqual([0, 0, FLAG_REPORTED, FLAG_REPORTED, FLAG_REPORTED | FLAG_BADLANDS])
    const log = await t.db
      .prepare(
        "SELECT COUNT(*) AS n FROM moderation_log WHERE account_id = ? AND source = 'reports'",
      )
      .bind(target.id)
      .first<{ n: number }>()
    expect(log?.n).toBe(2)
    const bad = await call('POST', '/reports', {
      as: target.id,
      body: { name: target.name, reason: 'cheating' },
    })
    expect(bad.status).toBe(400)
  })
})

describe('while you were away', () => {
  it('reports royalties since the last acknowledgement', async () => {
    const p = await player()
    await t.db.batch(
      ledgerStatements(t.env, `roy:${p.id}:1`, [
        { accountId: p.id, kind: 'ghost_royalty', amount: 12 },
      ]),
    )
    await t.db.batch(
      ledgerStatements(t.env, `roy:${p.id}:2`, [
        { accountId: p.id, kind: 'ghost_royalty', amount: 29 },
      ]),
    )
    const me = (await call('GET', '/me', { as: p.id })).body as MeResponse
    expect(me.away.royalties).toEqual({ count: 2, amount: 41 })
    expect(me.away.total).toBe(41)
    expect(me.away.since).toBeNull()
    const ack = await call('POST', '/me/away/ack', { as: p.id, body: { asOf: me.away.asOf } })
    expect(ack.status).toBe(204)
    const after = (await call('GET', '/me', { as: p.id })).body as MeResponse
    expect(after.away.total).toBe(0)
    expect(after.away.since).toBe(me.away.asOf)
  })
})
