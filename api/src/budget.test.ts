import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'
import { budgetState, CEILINGS, recordUsage } from './budget.ts'
import { type TestDb, testDb } from './economy/testing/d1.ts'

let fixture: TestDb
beforeAll(async () => {
  fixture = await testDb()
})
afterAll(async () => {
  await fixture.dispose()
})
describe('Workers Free budget', () => {
  it('uses UTC daily rows, preserves prior monthly usage and closes both modes at ceiling', async () => {
    const date = new Date().toISOString().slice(0, 10)
    await fixture.db
      .prepare('INSERT INTO usage(month,metric,amount) VALUES(?,?,?)')
      .bind(date.slice(0, 7), 'lobby_seconds', 9_000_000)
      .run()
    expect((await budgetState(fixture.env)).frontierOpen).toBe(true)
    await recordUsage(fixture.env, 'lobby_seconds', CEILINGS.lobby_seconds)
    const state = await budgetState(fixture.env)
    expect(state.month).toBe(date)
    expect(state.frontierOpen).toBe(false)
    expect(state.duelsOpen).toBe(false)
    const old = await fixture.db
      .prepare('SELECT amount FROM usage WHERE month=? AND metric=?')
      .bind(date.slice(0, 7), 'lobby_seconds')
      .first<{ amount: number }>()
    expect(old?.amount).toBe(9_000_000)
  })
  it('combined duration allocation is80percent and messages leave coordination headroom', () => {
    expect((CEILINGS.lobby_seconds + CEILINGS.duel_seconds) * 0.125).toBe(13_000 * 0.8)
    expect(CEILINGS.ws_messages / 20).toBeLessThan(100_000 * 0.8)
  })
})
