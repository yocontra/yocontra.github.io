/**
 * Cloudflare RealtimeKit, server side: meetings and participant tokens.
 *
 * The browser never sees the Cloudflare API token. A Durable Object asks this module for a
 * participant token when a player turns proximity voice on, then hands only that short-lived
 * RealtimeKit JWT to the client. RealtimeKit does the media routing, TURN and reconnect work.
 */
import type { Env } from '../env.ts'

const API = 'https://api.cloudflare.com/client/v4'
/** Two hours is long enough for a session and short enough that a leaked token dies quickly. */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000

interface CfResponse<T> {
  success?: boolean
  data?: T
  result?: T
  errors?: { message?: string }[]
}

export interface VoiceParticipant {
  id: string
  token: string
}

const iso = (ms: number): string => new Date(ms).toISOString()

export const voiceConfigured = (env: Env): boolean =>
  Boolean(
    env.CLOUDFLARE_ACCOUNT_ID &&
      env.REALTIMEKIT_APP_ID &&
      env.REALTIMEKIT_API_TOKEN &&
      env.REALTIMEKIT_PRESET,
  )

async function call<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!voiceConfigured(env)) {
    throw new Error('Voice is not configured.')
  }
  const url = `${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await res.json().catch(() => null)) as CfResponse<T> | null
  const data = body?.data ?? body?.result
  if (!res.ok || body?.success === false) {
    throw new Error(body?.errors?.[0]?.message ?? `RealtimeKit returned ${res.status}`)
  }
  return data as T
}

/** Create a reusable meeting. Sessions start when the first participant joins. */
export async function createVoiceMeeting(env: Env, title: string): Promise<string> {
  const data = await call<{ id: string }>(env, '/meetings', {
    method: 'POST',
    body: JSON.stringify({
      title,
      record_on_start: false,
      persist_chat: false,
      // Keep a short tail after the last player leaves so a reconnect lands back in the same session.
      session_keep_alive_time_in_secs: 60,
    }),
  })
  return data.id
}

/** Add (or refresh) a participant, returning the client auth token. */
export async function addVoiceParticipant(
  env: Env,
  meetingId: string,
  name: string,
  customId: string,
): Promise<VoiceParticipant> {
  const now = Date.now()
  const data = await call<{ id: string; token: string }>(
    env,
    `/meetings/${encodeURIComponent(meetingId)}/participants`,
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        custom_participant_id: customId,
        preset_name: env.REALTIMEKIT_PRESET,
        token: {
          not_before: iso(now - 60_000),
          expires_on: iso(now + TOKEN_TTL_MS),
        },
      }),
    },
  )
  return { id: data.id, token: data.token }
}

/** Issue a fresh token for an existing participant (a reconnect). */
export async function refreshVoiceToken(
  env: Env,
  meetingId: string,
  participantId: string,
): Promise<string> {
  const now = Date.now()
  const data = await call<{ token: string }>(
    env,
    `/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}/token`,
    {
      method: 'POST',
      body: JSON.stringify({
        not_before: iso(now - 60_000),
        expires_on: iso(now + TOKEN_TTL_MS),
      }),
    },
  )
  return data.token
}

export async function removeVoiceParticipant(
  env: Env,
  meetingId: string,
  participantId: string,
): Promise<void> {
  await call(
    env,
    `/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}`,
    { method: 'DELETE' },
  )
}
