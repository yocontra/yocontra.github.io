/**
 * The hub's HTTP calls: profile, ledger, store, loadout and the queue ticket. Built on stream A's
 * `apiFetch` (Bearer auth, one silent refresh on 401, `PUBLIC_API_URL` base). Every call resolves
 * to a typed result and never throws.
 */
import type { DuelSettings, DuelStatsResponse, QueueTicketResponse } from '../contract/duel.ts'
import type {
  BuyResponse,
  LedgerRow,
  LoadoutResponse,
  MeResponse,
  StoreResponse,
} from '../contract/economy.ts'
import type { ItemId, Loadout } from '../data/catalog.ts'
import { apiFetch } from './auth.ts'
import type { Result } from './leaderboard.ts'

const TIMEOUT_MS = 8000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function errorOf(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string') {
    return body.error
  }
  if (status === 401) {
    return 'Sign in first, partner.'
  }
  if (status === 429) {
    return 'Easy, partner. Try again in a bit.'
  }
  return 'The server sent something odd back.'
}

/** JSON in, JSON out, with a timeout. `check` shapes the body; a failed check is an error. */
export async function apiJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  check: (v: unknown) => v is T = (v): v is T => v !== undefined,
): Promise<Result<T>> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await apiFetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      body: init.body === undefined ? null : JSON.stringify(init.body),
      signal: ctl.signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: errorOf(body, res.status) }
    }
    return check(body)
      ? { ok: true, value: body }
      : { ok: false, error: 'The server sent something odd back.' }
  } catch {
    return { ok: false, error: 'Couldn’t reach the server.' }
  } finally {
    clearTimeout(timer)
  }
}

const isMe = (v: unknown): v is MeResponse =>
  isRecord(v) &&
  typeof v.name === 'string' &&
  typeof v.purse === 'number' &&
  typeof v.xp === 'number' &&
  typeof v.level === 'number' &&
  isRecord(v.loadout) &&
  Array.isArray(v.owned)

const isStore = (v: unknown): v is StoreResponse =>
  isRecord(v) && Array.isArray(v.owned) && Array.isArray(v.items)

export const fetchMe = (): Promise<Result<MeResponse>> => apiJson('/me', {}, isMe)

export async function fetchLedger(limit = 12): Promise<Result<LedgerRow[]>> {
  const r = await apiJson(`/me/ledger?limit=${limit}`, {}, isRecord)
  if (!r.ok) {
    return r
  }
  const entries = r.value.entries
  return Array.isArray(entries)
    ? { ok: true, value: entries as LedgerRow[] }
    : { ok: false, error: 'The ledger came back smudged.' }
}

export const fetchStore = (): Promise<Result<StoreResponse>> => apiJson('/store', {}, isStore)

export const buyItem = (itemId: ItemId): Promise<Result<BuyResponse>> =>
  apiJson(
    '/store/buy',
    { body: { itemId } },
    (v): v is BuyResponse => isRecord(v) && v.ok === true && Array.isArray(v.owned),
  )

export const saveLoadout = (loadout: Loadout): Promise<Result<LoadoutResponse>> =>
  apiJson(
    '/me/loadout',
    { method: 'PUT', body: { loadout } },
    (v): v is LoadoutResponse => isRecord(v) && isRecord(v.loadout),
  )

export const queueTicket = (turnstileToken: string): Promise<Result<QueueTicketResponse>> =>
  apiJson(
    '/queue/ticket',
    { body: { turnstileToken } },
    (v): v is QueueTicketResponse => isRecord(v) && typeof v.wsUrl === 'string',
  )

export const fetchDuelSettings = (): Promise<Result<DuelSettings>> =>
  apiJson(
    '/duel/settings',
    {},
    (v): v is DuelSettings => isRecord(v) && typeof v.ghostOptOut === 'boolean',
  )

export const saveDuelSettings = (s: DuelSettings): Promise<Result<DuelSettings>> =>
  apiJson(
    '/duel/settings',
    { method: 'PUT', body: s },
    (v): v is DuelSettings => isRecord(v) && typeof v.ghostOptOut === 'boolean',
  )

export const fetchDuelStats = (): Promise<Result<DuelStatsResponse>> =>
  apiJson(
    '/duel/stats',
    {},
    (v): v is DuelStatsResponse => isRecord(v) && typeof v.wins === 'number',
  )
