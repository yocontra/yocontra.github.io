/**
 * The shared leaderboard (Cloudflare Worker + D1). Every call resolves to a
 * typed result and never throws: offline, rate limits and rejections become a
 * short, polite message and the game carries on.
 */
import { API_URL } from './auth.ts'

export interface BoardEntry {
  rank: number
  name: string
  total: number
  createdAt: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** The leaderboard lives on the one API host (`api.contra.io` in production). */
export const LEADERBOARD_URL = API_URL

const TIMEOUT_MS = 8000
const NAME_KEY = 'out-west-3d-name'

export const NAME_MAX = 16

/** Trim and collapse whitespace; null when it isn't 1–16 characters. */
export function cleanName(raw: string): string | null {
  const n = raw.replace(/\s+/gu, ' ').trim()
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
    typeof v.rank === 'number' &&
    typeof v.name === 'string' &&
    typeof v.total === 'number' &&
    typeof v.createdAt === 'number'
  )
}

function politeStatus(status: number, server: string | null): string {
  if (status === 429) {
    return 'Too many tries. Wait a minute and try again.'
  }
  if (status >= 500) {
    return 'Leaderboard trouble. Try again in a few minutes.'
  }
  if (server) {
    return server
  }
  return 'The leaderboard refused that.'
}

async function call(path: string, init: RequestInit = {}): Promise<Result<unknown>> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, error: 'You look to be offline.' }
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
      const msg = isRecord(body) && typeof body.error === 'string' ? body.error : null
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
  if (!r.ok) {
    return r
  }
  const v = r.value
  if (!(isRecord(v) && Array.isArray(v.entries))) {
    return { ok: false, error: 'The leaderboard sent something odd back.' }
  }
  return { ok: true, value: v.entries.filter(isEntry) }
}
