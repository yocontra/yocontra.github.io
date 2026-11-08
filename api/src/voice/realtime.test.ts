import { afterEach, describe, expect, test as it, spyOn } from 'bun:test'
import type { Env } from '../env.ts'
import {
  addVoiceParticipant,
  createVoiceMeeting,
  refreshVoiceToken,
  removeVoiceParticipant,
  voiceConfigured,
} from './realtime.ts'

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'account',
  REALTIMEKIT_APP_ID: 'app',
  REALTIMEKIT_PRESET: 'out-west-voice',
  REALTIMEKIT_API_TOKEN: 'secret',
} as Env

let calls: { url: string; init: RequestInit | undefined }[] = []
const restore: (() => void)[] = []

afterEach(() => {
  for (const fn of restore.splice(0)) {
    fn()
  }
  calls = []
})

function mock(data: unknown): void {
  const impl = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const spy = spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch)
  restore.push(() => spy.mockRestore())
}

describe('RealtimeKit voice service', () => {
  it('knows when it is not configured', () => {
    expect(voiceConfigured({} as Env)).toBe(false)
    expect(voiceConfigured(env)).toBe(true)
    expect(voiceConfigured({ ...env, DISABLE_VOICE: 'true' })).toBe(false)
  })

  it('creates an audio-only meeting', async () => {
    mock({ id: 'meeting-1' })
    await expect(createVoiceMeeting(env, 'frontier-lobby:0')).resolves.toBe('meeting-1')
    expect(calls[0]?.url).toContain('/realtime/kit/app/meetings')
    expect(calls[0]?.init?.method).toBe('POST')
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).toMatchObject({
      title: 'frontier-lobby:0',
      record_on_start: false,
      persist_chat: false,
      session_keep_alive_time_in_secs: 60,
    })
  })

  it('adds a participant with a short-lived token', async () => {
    mock({ id: 'participant-1', token: 'jwt' })
    await expect(addVoiceParticipant(env, 'meeting-1', 'Ada', '12')).resolves.toEqual({
      id: 'participant-1',
      token: 'jwt',
    })
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).toMatchObject({
      name: 'Ada',
      custom_participant_id: '12',
      preset_name: 'out-west-voice',
    })
    expect(typeof body.token.expires_on).toBe('string')
  })

  it('refreshes a participant token and removes a participant', async () => {
    mock({ token: 'fresh' })
    await expect(refreshVoiceToken(env, 'meeting-1', 'participant-1')).resolves.toBe('fresh')
    expect(calls[0]?.url).toContain('/meetings/meeting-1/participants/participant-1/token')
    mock(undefined)
    await expect(removeVoiceParticipant(env, 'meeting-1', 'participant-1')).resolves.toBeUndefined()
    expect(calls[1]?.init?.method).toBe('DELETE')
  })

  it('surfaces Cloudflare errors without leaking the token', async () => {
    const impl = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    const spy = spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch)
    restore.push(() => spy.mockRestore())
    await expect(createVoiceMeeting(env, 'x')).rejects.toThrow('nope')
  })
})
