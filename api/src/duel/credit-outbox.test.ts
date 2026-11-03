/**
 * The ranked credit outbox against a real local D1 (workerd) and stream C's real gauntlet grants:
 * a failed write is retried, a reset between the verdict and the write still pays, and a retry of
 * a write that did commit pays nothing twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gauntletClearStatements } from '../economy/gauntlet.ts'
import { createProfile, getProfileDetail } from '../economy/profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from '../economy/testing/d1.ts'
import { type CreditJob, CreditOutbox, type OutboxStorage, retryDelay } from './credit-outbox.ts'

let t: TestDb

beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

/** Durable Object storage, as far as the outbox uses it. Survives "resets" (new outboxes). */
class FakeStorage implements OutboxStorage {
  readonly data = new Map<string, unknown>()
  alarm: number | null = null

  put = (key: string, value: unknown): Promise<void> => {
    this.data.set(key, structuredClone(value))
    return Promise.resolve()
  }

  delete = (key: string): Promise<boolean> => Promise.resolve(this.data.delete(key))

  list = ({ prefix }: { prefix: string }): Promise<Map<string, unknown>> =>
    Promise.resolve(
      new Map(
        [...this.data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    )

  getAlarm = (): Promise<number | null> => Promise.resolve(this.alarm)

  setAlarm = (at: number): Promise<void> => {
    this.alarm = at
    return Promise.resolve()
  }

  deleteAlarm = (): Promise<void> => {
    this.alarm = null
    return Promise.resolve()
  }
}

async function newPlayer(): Promise<string> {
  const id = freshId()
  await insertAccount(t.db, id, 'Outbox')
  await createProfile(t.env, id, 'Outbox')
  return id
}

/** The DuelSession's apply, minus ghosts: the gauntlet grant in one batch. */
async function applyGauntlet(job: CreditJob): Promise<void> {
  const statements = job.paidWin
    ? await gauntletClearStatements(t.env, job.accountId, job.level, job.runId)
    : []
  if (statements.length > 0) {
    await t.db.batch(statements)
  }
}

const jobFor = (accountId: string, level: number, runId = 'run-a'): CreditJob => ({
  accountId,
  runId,
  level,
  paidWin: true,
  ghost: null,
})

async function clearsOf(accountId: string): Promise<{ clears: number; xp: number }> {
  const p = await getProfileDetail(t.env, accountId)
  return { clears: p?.gauntletClears ?? -1, xp: p?.xp ?? -1 }
}

const silent = (): void => undefined

describe('ranked credit outbox', () => {
  it('a failed write stays queued, schedules a retry, and pays once when it succeeds', async () => {
    const id = await newPlayer()
    const storage = new FakeStorage()
    let failNext = true
    const logged: unknown[] = []
    const outbox = new CreditOutbox({
      storage,
      now: () => 1000,
      log: (_m, d) => logged.push(d),
      apply: (j) => {
        if (failNext) {
          failNext = false
          return Promise.reject(new Error('D1_ERROR: Network connection lost.'))
        }
        return applyGauntlet(j)
      },
    })
    for (const level of [0, 1]) {
      // biome-ignore lint/performance/noAwaitInLoops: duels happen in order
      await outbox.enqueue(String(level), jobFor(id, level))
      await outbox.drain()
    }
    await outbox.enqueue('2', jobFor(id, 2))
    failNext = true
    await outbox.drain()
    // the third first clear failed: still owed, logged loudly, alarm set
    expect(await clearsOf(id)).toEqual({ clears: 0b011, xp: 40 + 55 })
    expect(await outbox.pending()).toEqual([jobFor(id, 2)])
    expect(logged).toHaveLength(2)
    expect(storage.alarm).toBe(1000 + retryDelay(1))
    // the alarm fires
    await outbox.drain()
    expect(await clearsOf(id)).toEqual({ clears: 0b111, xp: 40 + 55 + 70 })
    expect(await outbox.pending()).toEqual([])
    expect(storage.alarm).toBeNull()
  })

  it('a reset between the verdict and the write still pays (the job is on disk)', async () => {
    const id = await newPlayer()
    const storage = new FakeStorage()
    const before = new CreditOutbox({ storage, apply: applyGauntlet, log: silent })
    await before.enqueue('0', jobFor(id, 0))
    // ...the object is evicted or redeployed before drain() runs. The safety alarm is set:
    expect(storage.alarm).not.toBeNull()
    // and when it fires, a fresh instance drains the job:
    const after = new CreditOutbox({ storage, apply: applyGauntlet, log: silent })
    await after.drain()
    expect(await clearsOf(id)).toEqual({ clears: 0b1, xp: 40 })
  })

  it('retrying a write that did commit pays nothing twice (no repeat XP either)', async () => {
    const id = await newPlayer()
    const storage = new FakeStorage()
    let lostAck = true
    const outbox = new CreditOutbox({
      storage,
      log: silent,
      apply: async (j) => {
        await applyGauntlet(j)
        if (lostAck) {
          lostAck = false
          throw new Error('the reply was lost after commit')
        }
      },
    })
    await outbox.enqueue('0', jobFor(id, 0))
    await outbox.drain()
    await outbox.drain()
    expect(await clearsOf(id)).toEqual({ clears: 0b1, xp: 40 })
    expect(await outbox.pending()).toEqual([])
    // the same outlaw on a later run is a repeat, as before
    await applyGauntlet(jobFor(id, 0, 'run-b'))
    expect(await clearsOf(id)).toEqual({ clears: 0b1, xp: 50 })
  })

  it('backs off from 2 s to at most 5 minutes', () => {
    expect([1, 2, 3, 20].map(retryDelay)).toEqual([2000, 4000, 8000, 300_000])
  })
})
