/** The Badlands writers against a real local D1: timing review and flag bookkeeping. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createProfile } from '../economy/profile.ts'
import { freshId, insertAccount, type TestDb, testDb } from '../economy/testing/d1.ts'
import { FLAG_BADLANDS, flagAccount, standing } from './flags.ts'
import { block } from './reports.ts'
import { reviewTiming } from './timing.ts'

let t: TestDb
beforeAll(async () => {
  t = await testDb()
})
afterAll(async () => {
  await t.dispose()
})

async function player(): Promise<string> {
  const id = freshId('mod')
  await insertAccount(t.db, id, 'Suspect')
  await createProfile(t.env, id, 'Suspect')
  await t.db
    .prepare(
      `INSERT INTO ghost_profiles (account_id, name, level, samples, updated_at)
       VALUES (?, 'Suspect', 1, 20, ?)`,
    )
    .bind(id, Date.now())
    .run()
  return id
}

async function samples(id: string, ms: readonly number[]): Promise<void> {
  await t.db.batch(
    ms.map((m) =>
      t.db
        .prepare(
          "INSERT INTO ghost_samples (account_id, ms, source, created_at) VALUES (?, ?, 'pvp', ?)",
        )
        .bind(id, m, Date.now()),
    ),
  )
}

const flagsOf = async (id: string) =>
  (
    await t.db
      .prepare('SELECT flags FROM accounts WHERE id = ?')
      .bind(id)
      .first<{ flags: number }>()
  )?.flags

describe('timing review', () => {
  it('a robotic player goes to the Badlands and their ghost is pulled', async () => {
    const id = await player()
    await samples(
      id,
      Array.from({ length: 20 }, (_, i) => 180 + (i % 3)),
    )
    expect(await reviewTiming(t.env, id)).toEqual(['steady'])
    expect(await flagsOf(id)).toBe(FLAG_BADLANDS)
    const ghost = await t.db
      .prepare('SELECT flagged FROM ghost_profiles WHERE account_id = ?')
      .bind(id)
      .first<{ flagged: number }>()
    expect(ghost?.flagged).toBe(1)
    const log = await t.db
      .prepare('SELECT source, detail FROM moderation_log WHERE account_id = ?')
      .bind(id)
      .all<{ source: string; detail: string }>()
    expect(log.results).toEqual([{ source: 'timing', detail: 'steady' }])
    // Reviewing again logs nothing new.
    await reviewTiming(t.env, id)
    const again = await t.db
      .prepare('SELECT COUNT(*) AS n FROM moderation_log WHERE account_id = ?')
      .bind(id)
      .first<{ n: number }>()
    expect(again?.n).toBe(1)
  })

  it('a human spread stays honest', async () => {
    const id = await player()
    await samples(
      id,
      Array.from({ length: 30 }, (_, i) => 190 + ((i * 37) % 90)),
    )
    expect(await reviewTiming(t.env, id)).toEqual([])
    expect(await flagsOf(id)).toBe(0)
  })
})

describe('standing', () => {
  it('reports flags and blocks in both directions', async () => {
    const [a, b, c] = [await player(), await player(), await player()]
    await block(t.env, { blockerId: a, targetId: b })
    await block(t.env, { blockerId: c, targetId: a })
    await flagAccount(t.env, { accountId: a, bits: FLAG_BADLANDS, source: 'admin' })
    const s = await standing(t.env, a)
    expect(s.flags).toBe(FLAG_BADLANDS)
    expect(new Set(s.blocked)).toEqual(new Set([b, c]))
  })
})
