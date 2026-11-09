import { expect, test as it } from 'bun:test'
import type { Env } from '../env.ts'
import {
  reserveVoiceBudget,
  VOICE_LEASE_MS,
  VOICE_RENEW_MS,
  VOICE_RESERVED_LIMIT,
  VOICE_RESERVED_SECONDS,
  VoiceBudgetError,
} from './budget.ts'

it('free reservations leave headroom and exceed the active lease plus the provider request timeout', () => {
  expect(VOICE_RESERVED_LIMIT).toBe(9000 * 60)
  expect(VOICE_RENEW_MS).toBeLessThan(VOICE_LEASE_MS)
  expect(VOICE_RESERVED_SECONDS * 1000).toBeGreaterThan(VOICE_LEASE_MS + 10_000)
})
it('invalid audiences never touch D1 and D1 failures have a safe actionable message', async () => {
  const env = {} as Env
  let queries = 0
  Reflect.set(env, 'DB', {
    prepare() {
      queries++
      throw new Error('fixture database unavailable')
    },
  })
  await expect(reserveVoiceBudget(env, 0)).rejects.toBeInstanceOf(VoiceBudgetError)
  await expect(reserveVoiceBudget(env, 33)).rejects.toBeInstanceOf(VoiceBudgetError)
  expect(queries).toBe(0)
  await expect(reserveVoiceBudget(env, 2)).rejects.toThrow(
    'free safety budget could not be checked',
  )
  expect(queries).toBe(1)
})
