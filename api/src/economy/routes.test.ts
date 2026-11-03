import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type {
  BuyResponse,
  LedgerResponse,
  MeResponse,
  StoreResponse,
} from '../../../src/experiments/out-west/contract/economy.ts'
import { DEFAULT_LOADOUT } from '../../../src/experiments/out-west/data/catalog.ts'
import { signAccessToken } from '../auth/token.ts'
import { meRoutes } from '../routes/me.ts'
import { purchaseStatements, storeRoutes } from '../routes/store.ts'
import { auditLedger } from './audit.ts'
import { ledgerStatements } from './ledger.ts'
import { createProfile } from './profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from './testing/d1.ts'

let t: TestDb
beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

const ctx = {} as ExecutionContext

async function call(
  method: string,
  path: string,
  opts: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, 'http://localhost:8793')
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
    (await meRoutes(request, t.env, url, ctx)) ?? (await storeRoutes(request, t.env, url, ctx))
  if (!response) {
    return { status: 0, body: null }
  }
  return { status: response.status, body: await response.json() }
}

async function player(purse = 0): Promise<string> {
  const id = freshId()
  await insertAccount(t.db, id, 'Tester')
  await createProfile(t.env, id, 'Tester')
  if (purse > 0) {
    await t.db.batch(
      ledgerStatements(t.env, `seed:${id}`, [
        { accountId: id, kind: 'admin_adjust', amount: purse },
      ]),
    )
  }
  return id
}

describe('GET /me', () => {
  it('needs auth', async () => {
    expect((await call('GET', '/me')).status).toBe(401)
  })

  it('returns the profile with title, bounty and owned items', async () => {
    const id = await player()
    const { status, body } = await call('GET', '/me', { as: id })
    const me = body as MeResponse
    expect(status).toBe(200)
    expect(me).toMatchObject({
      accountId: id,
      purse: 250,
      level: 1,
      title: 'Greenhorn',
      bounty: 50,
    })
    expect(me.xpNext).toBe(150)
    expect(me.owned).toHaveLength(8)
  })

  it('creates a missing profile on first sight', async () => {
    const id = freshId()
    await insertAccount(t.db, id, 'Late')
    expect(((await call('GET', '/me', { as: id })).body as MeResponse).purse).toBe(250)
  })

  it('rejects a forged token', async () => {
    const url = new URL('https://api.contra.io/me')
    const req = new Request(url, { headers: { Authorization: 'Bearer dev:x:y' } })
    expect((await meRoutes(req, t.env, url, ctx))?.status).toBe(401)
  })
})

describe('GET /me/ledger', () => {
  it('lists newest first with a limit', async () => {
    const id = await player(1000)
    const { body } = await call('GET', '/me/ledger?limit=1', { as: id })
    const { entries } = body as LedgerResponse
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'admin_adjust', amount: 1000, balanceAfter: 1250 })
  })
})

describe('POST /store/buy', () => {
  it('debits and grants atomically', async () => {
    const id = await player(250)
    const { status, body } = await call('POST', '/store/buy', {
      as: id,
      body: { itemId: 'hat.plainsman' },
    })
    expect(status).toBe(200)
    expect(body as BuyResponse).toMatchObject({ ok: true, purse: 250 })
    expect((body as BuyResponse).owned).toContain('hat.plainsman')
    expect((await auditLedger(t.env)).mismatches).toEqual([])
  })

  it('refuses a second purchase of the same item, without charging', async () => {
    const id = await player(1000)
    await call('POST', '/store/buy', { as: id, body: { itemId: 'hat.plainsman' } })
    const again = await call('POST', '/store/buy', { as: id, body: { itemId: 'hat.plainsman' } })
    expect(again.status).toBe(409)
    expect(((await call('GET', '/me', { as: id })).body as MeResponse).purse).toBe(1000)
  })

  it('a replayed purchase batch is a no-op; a raced duplicate never double-charges', async () => {
    const id = await player(1000)
    const replays = Array.from({ length: 5 }, () =>
      t.db.batch(purchaseStatements(t.env, id, 'gun.blued-six', 300)),
    )
    await Promise.allSettled(replays)
    const me = (await call('GET', '/me', { as: id })).body as MeResponse
    expect(me.purse).toBe(950)
    expect(me.owned.filter((i) => i === 'gun.blued-six')).toHaveLength(1)
  })

  it('an item owned by another route aborts the batch (no charge)', async () => {
    const id = await player(1000)
    await t.db
      .prepare(
        "INSERT INTO inventory (account_id, item_id, source, acquired_at) VALUES (?, 'gun.blued-six', 'reward', 0)",
      )
      .bind(id)
      .run()
    await expect(t.db.batch(purchaseStatements(t.env, id, 'gun.blued-six', 300))).rejects.toThrow()
    expect(((await call('GET', '/me', { as: id })).body as MeResponse).purse).toBe(1250)
  })

  it('refuses funds, level gates, starters, rewards and unknown items', async () => {
    const id = await player()
    const tries: [unknown, number][] = [
      ['extra.red-bandana', 403],
      ['hat.plainsman', 200],
      ['gun.blued-six', 402],
      ['gun.rusty-six', 403],
      ['gun.hardins-pair', 403],
      ['nope', 400],
      [42, 400],
    ]
    for (const [itemId, status] of tries) {
      // biome-ignore lint/performance/noAwaitInLoops: purchases are sequential
      expect((await call('POST', '/store/buy', { as: id, body: { itemId } })).status).toBe(status)
    }
  })

  it('an overdraft inside the batch is reported as 402', async () => {
    const id = await player()
    let caught: unknown = null
    try {
      await t.db.batch(purchaseStatements(t.env, id, 'gun.nickel-six', 1800))
    } catch (err) {
      caught = err
    }
    expect(String(caught)).toContain('CHECK constraint failed')
  })
})

describe('GET /store', () => {
  it('works signed out', async () => {
    const { body } = await call('GET', '/store')
    const store = body as StoreResponse
    expect(store.items).toHaveLength(43)
    expect(store.owned).toEqual([])
    expect(store.purse).toBeNull()
  })

  it('shows owned items and purse when signed in', async () => {
    const id = await player()
    const store = (await call('GET', '/store', { as: id })).body as StoreResponse
    expect(store.owned).toHaveLength(8)
    expect(store.purse).toBe(250)
  })
})

describe('PUT /me/loadout', () => {
  it('equips owned items only', async () => {
    const id = await player(1000)
    await call('POST', '/store/buy', { as: id, body: { itemId: 'hat.plainsman' } })
    const ok = await call('PUT', '/me/loadout', {
      as: id,
      body: { loadout: { ...DEFAULT_LOADOUT, hat: 'hat.plainsman' } },
    })
    expect(ok.status).toBe(200)
    const me = (await call('GET', '/me', { as: id })).body as MeResponse
    expect(me.loadout.hat).toBe('hat.plainsman')

    const notOwned = await call('PUT', '/me/loadout', {
      as: id,
      body: { loadout: { ...DEFAULT_LOADOUT, gun: 'gun.gilded-sovereign' } },
    })
    expect(notOwned.status).toBe(400)
    const wrongSlot = await call('PUT', '/me/loadout', {
      as: id,
      body: { loadout: { ...DEFAULT_LOADOUT, hat: 'gun.rusty-six' } },
    })
    expect(wrongSlot.status).toBe(400)
    expect(((await call('GET', '/me', { as: id })).body as MeResponse).loadout.hat).toBe(
      'hat.plainsman',
    )
  })
})

describe('POST /me/prestige', () => {
  it('only at L50; resets level and XP, keeps the wallet', async () => {
    const id = await player()
    expect((await call('POST', '/me/prestige', { as: id })).status).toBe(409)
    await t.db.batch(
      ledgerStatements(t.env, `max:${id}`, [
        { accountId: id, kind: 'admin_adjust', amount: 0, xp: 101_430 },
      ]),
    )
    const before = ((await call('GET', '/me', { as: id })).body as MeResponse).purse
    const { status, body } = await call('POST', '/me/prestige', { as: id })
    expect(status).toBe(200)
    expect(body as MeResponse).toMatchObject({
      level: 1,
      xp: 0,
      prestige: 1,
      purse: before,
      bounty: 60,
    })
  })
})
