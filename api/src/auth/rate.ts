/**
 * Fixed-window rate limits for auth endpoints, counted in D1 (auth traffic is rare, so one upsert
 * per call is cheap and needs no extra bindings). Buckets hash the client (`clientHash`, never a
 * raw IP) or name an account. Owned by stream A.
 */
import type { Env } from '../env.ts'

export interface Limit {
  /** Bucket prefix, e.g. `reg`. */
  name: string
  max: number
  windowMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Per-client limits unless noted. */
export const LIMITS = {
  register: { name: 'reg', max: 10, windowMs: HOUR },
  login: { name: 'login', max: 40, windowMs: HOUR },
  verify: { name: 'verify', max: 40, windowMs: HOUR },
  refresh: { name: 'refresh', max: 120, windowMs: HOUR },
  appToken: { name: 'apptok', max: 20, windowMs: HOUR },
  /** Per account. */
  tickets: { name: 'ticket', max: 60, windowMs: MINUTE },
  /** Per account. */
  sensitive: { name: 'sens', max: 10, windowMs: HOUR },
} as const satisfies Record<string, Limit>

export interface RateVerdict {
  ok: boolean
  /** Seconds until the window resets (for `Retry-After`). */
  retryAfter: number
}

/** Counts one hit and reports whether it is within the limit. */
export async function hit(
  env: Env,
  limit: Limit,
  key: string,
  now = Date.now(),
): Promise<RateVerdict> {
  const windowStart = now - (now % limit.windowMs)
  const bucket = `${limit.name}:${key}`
  const [, counted] = await env.DB.batch([
    // Sweep old windows for this bucket only, so the table stays small without a cron.
    env.DB.prepare('DELETE FROM auth_rate WHERE bucket = ? AND window_start < ?').bind(
      bucket,
      windowStart,
    ),
    env.DB.prepare(
      `INSERT INTO auth_rate (bucket, window_start, hits) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1
       RETURNING hits`,
    ).bind(bucket, windowStart),
  ])
  const hits = (counted?.results[0] as { hits?: number } | undefined)?.hits ?? 1
  return {
    ok: hits <= limit.max,
    retryAfter: Math.max(1, Math.ceil((windowStart + limit.windowMs - now) / 1000)),
  }
}
