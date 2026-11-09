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

export class VoiceServiceError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

export const voiceConfigured = (env: Env): boolean =>
  Boolean(
    env.DISABLE_VOICE !== 'true' &&
      env.CLOUDFLARE_ACCOUNT_ID &&
      env.REALTIMEKIT_APP_ID &&
      env.REALTIMEKIT_API_TOKEN &&
      env.REALTIMEKIT_PRESET,
  )

async function call<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!(env.CLOUDFLARE_ACCOUNT_ID && env.REALTIMEKIT_APP_ID && env.REALTIMEKIT_API_TOKEN)) {
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
    throw new VoiceServiceError(
      body?.errors?.[0]?.message ?? `RealtimeKit returned ${res.status}`,
      res.status,
    )
  }
  return data as T
}

/** Create a reusable meeting. Sessions start when the first participant joins. */
export async function createVoiceMeeting(env: Env, title: string): Promise<string> {
  if (!voiceConfigured(env)) {
    throw new Error('Voice is not configured.')
  }
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
  if (!voiceConfigured(env)) {
    throw new Error('Voice is not configured.')
  }
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
  if (!voiceConfigured(env)) {
    throw new Error('Voice is not configured.')
  }
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
  try {
    await call(
      env,
      `/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}`,
      { method: 'DELETE' },
    )
  } catch (error) {
    if (!(error instanceof VoiceServiceError && error.status === 404)) {
      throw error
    }
  }
}

/** Explicitly ends the active session; token expiry or an empty keepalive is insufficient. */
export async function endVoiceSession(env: Env, meetingId: string): Promise<void> {
  try {
    await call(env, `/meetings/${encodeURIComponent(meetingId)}/active-session/kick-all`, {
      method: 'POST',
    })
  } catch (error) {
    if (!(error instanceof VoiceServiceError && error.status === 404)) {
      throw error
    }
  }
}

export function voiceUnavailableMessage(env: Env): string {
  if (env.DISABLE_VOICE === 'true') {
    return 'Voice chat is disabled on this server.'
  }
  if (!voiceConfigured(env)) {
    return 'Voice chat is not configured on this server.'
  }
  return 'Voice service connection failed. Retry voice.'
}
