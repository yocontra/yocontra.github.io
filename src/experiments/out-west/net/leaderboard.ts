import type { RunResult } from '../data/economy'

/**
 * The shared leaderboard (Cloudflare Worker + D1). Every call resolves to a
 * typed result and never throws: offline, rate limits and rejections become a
 * short, polite message and the game carries on.
 */

export interface BoardEntry {
  rank: number
  name: string
  total: number
  createdAt: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface Submitted {
  total: number
  rank: number
}

const FALLBACK = import.meta.env.DEV ? 'http://localhost:8787' : 'https://leaderboard.contra.io'
const configured: unknown = import.meta.env['PUBLIC_LEADERBOARD_URL']
export const LEADERBOARD_URL = (
  typeof configured === 'string' && configured ? configured : FALLBACK
).replace(/\/+$/, '')

const TIMEOUT_MS = 8000
const NAME_KEY = 'out-west-3d-name'

export const NAME_MAX = 16

/** Trim and collapse whitespace; null when it isn't 1–16 characters. */
export function cleanName(raw: string): string | null {
  const n = raw.replace(/\s+/g, ' ').trim()
  const len = [...n].length
  return len >= 1 && len <= NAME_MAX ? n : null
}

export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // private mode: the name just won't be remembered
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function isEntry(v: unknown): v is BoardEntry {
  return (
    isRecord(v) &&
    typeof v['rank'] === 'number' &&
    typeof v['name'] === 'string' &&
    typeof v['total'] === 'number' &&
    typeof v['createdAt'] === 'number'
  )
}

function politeStatus(status: number, server: string | null): string {
  if (status === 429) return 'Whoa there, partner. Too many tries; give it a minute.'
  if (status >= 500) return 'The leaderboard is having a bad day. Try again later.'
  if (server) return server
  return 'The leaderboard turned that away.'
}

async function call(path: string, init: RequestInit = {}): Promise<Result<unknown>> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, error: 'You look to be offline. The leaderboard will keep.' }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${LEADERBOARD_URL}${path}`, { ...init, signal: ctrl.signal })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (!res.ok) {
      const msg = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : null
      return { ok: false, error: politeStatus(res.status, msg) }
    }
    return { ok: true, value: body }
  } catch {
    return { ok: false, error: 'Couldn’t reach the leaderboard. Try again in a bit.' }
  } finally {
    clearTimeout(timer)
  }
}

/** The top `limit` entries. */
export async function fetchTop(limit = 25): Promise<Result<BoardEntry[]>> {
  const r = await call(`/leaderboard?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`)
  if (!r.ok) return r
  const v = r.value
  if (!isRecord(v) || !Array.isArray(v['entries'])) {
    return { ok: false, error: 'The leaderboard sent something odd back.' }
  }
  return { ok: true, value: v['entries'].filter(isEntry) }
}

/** Submit a (possibly partial) run under `name`. The server rescores it. */
export async function submitRun(name: string, run: RunResult): Promise<Result<Submitted>> {
  const clean = cleanName(name)
  if (!clean) return { ok: false, error: `Pick a name of 1–${NAME_MAX} characters.` }
  const r = await call('/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: clean, run }),
  })
  if (!r.ok) return r
  const v = r.value
  if (!isRecord(v)) return { ok: false, error: 'The leaderboard sent something odd back.' }
  if (v['ok'] === false) {
    return {
      ok: false,
      error: typeof v['error'] === 'string' ? v['error'] : 'The leaderboard turned that away.',
    }
  }
  if (typeof v['total'] !== 'number' || typeof v['rank'] !== 'number') {
    return { ok: false, error: 'The leaderboard sent something odd back.' }
  }
  return { ok: true, value: { total: v['total'], rank: v['rank'] } }
}
