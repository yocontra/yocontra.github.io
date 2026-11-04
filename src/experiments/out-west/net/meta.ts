/**
 * The meta-game's HTTP calls (`contract/meta.ts`): progress, the guest purse migration, hat-shot
 * claims, Legend cosmetics and the Daily Outlaw. Every call resolves (never throws) with the HTTP
 * status, so callers can tell "already done" (409) from "try later". Old servers answer 404:
 * the meta-game then runs on the device alone.
 */
import type {
  ClaimResponse,
  DailyBoardResponse,
  DailyResponse,
  MigrateResponse,
  ProgressResponse,
} from '../contract/meta.ts'
import type { RankedSessionResponse } from '../contract/ranked.ts'
import type { GuestClaim } from '../data/medals.ts'
import { apiFetch } from './auth.ts'

const TIMEOUT_MS = 8000

export type Reply<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  check: (v: unknown) => boolean = isRecord,
): Promise<Reply<T>> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await apiFetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      body: init.body === undefined ? null : JSON.stringify(init.body),
      signal: ctl.signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const error =
        isRecord(body) && typeof body.error === 'string' ? body.error : 'The server said no.'
      return { ok: false, status: res.status, error }
    }
    return check(body)
      ? { ok: true, value: body as T }
      : { ok: false, status: 0, error: 'The server sent something odd back.' }
  } catch {
    return { ok: false, status: 0, error: 'Couldn’t reach the server.' }
  } finally {
    clearTimeout(timer)
  }
}

export const fetchProgress = (): Promise<Reply<ProgressResponse>> =>
  call('/progress', {}, (v) => isRecord(v) && Array.isArray(v.marks))

export const migrateGuest = (claim: GuestClaim): Promise<Reply<MigrateResponse>> =>
  call('/progress/migrate', { body: { claim } }, (v) => isRecord(v) && typeof v.xp === 'number')

export const claimChallenge = (challengeId: string, runId: string): Promise<Reply<ClaimResponse>> =>
  call('/progress/claim', { body: { challengeId, runId } })

export const claimLegend = (beaten: number): Promise<Reply<ProgressResponse>> =>
  call('/progress/legend', { body: { beaten } })

export const fetchDaily = (): Promise<Reply<DailyResponse>> =>
  call('/daily', {}, (v) => isRecord(v) && isRecord(v.spec))

export const fetchDailyBoard = (day?: string): Promise<Reply<DailyBoardResponse>> =>
  call(
    day ? `/daily/board?day=${encodeURIComponent(day)}` : '/daily/board',
    {},
    (v) => isRecord(v) && Array.isArray(v.rows),
  )

export const issueDaily = (turnstileToken: string): Promise<Reply<RankedSessionResponse>> =>
  call(
    '/daily/sessions',
    { body: { turnstileToken } },
    (v) => isRecord(v) && typeof v.wsUrl === 'string',
  )
