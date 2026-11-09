/** Conservative reservations inside the existing Free allowance; never a provider spend cap. */
import type { Env } from '../env.ts'

export const VOICE_RESERVED_LIMIT = 9000 * 60
export const VOICE_RESERVED_SECONDS = 60
export const VOICE_LEASE_MS = 30_000
export const VOICE_RENEW_MS = 20_000
const METRIC = 'voice_reserved_seconds'
const WINDOW_MS = 32 * 24 * 60 * 60 * 1000

export class VoiceBudgetError extends Error {}

/** One atomic D1 statement: concurrent rooms cannot spend the same remaining reservation. */
export async function reserveVoiceBudget(
  env: Env,
  participants: number,
  now = Date.now(),
): Promise<boolean> {
  if (!Number.isSafeInteger(participants) || participants < 1 || participants > 32) {
    throw new VoiceBudgetError('Voice safety budget received an invalid audience.')
  }
  const day = `voice:${new Date(now).toISOString().slice(0, 10)}`
  const since = `voice:${new Date(now - WINDOW_MS).toISOString().slice(0, 10)}`
  const seconds = participants * VOICE_RESERVED_SECONDS
  try {
    const result = await env.DB.prepare(`
      INSERT INTO usage(month,metric,amount)
      SELECT ?,?,? WHERE COALESCE((SELECT SUM(amount) FROM usage WHERE metric=? AND month>=?),0)+?<=?
      ON CONFLICT(month,metric) DO UPDATE SET amount=amount+excluded.amount
      RETURNING amount
    `)
      .bind(day, METRIC, seconds, METRIC, since, seconds, VOICE_RESERVED_LIMIT)
      .first<{ amount: number }>()
    return result !== null
  } catch (cause) {
    throw new VoiceBudgetError(
      'Voice is paused because its free safety budget could not be checked. Retry voice.',
      { cause },
    )
  }
}
