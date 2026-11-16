/** Same-origin local QA bootstrap and receipt sink for actual Simulator Safari. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { frameTiming } from './frame-timing.ts'
import {
  type BuildReceipt,
  localFixtureURL,
  requireLocalPerformanceFixture,
} from './production-fixture.ts'

const recordingId = /^[0-9a-f-]{36}$/u
function restorePage(id: string) {
  if (!recordingId.test(id)) {
    return new Response('Invalid recording id', { status: 400 })
  }
  return new Response(
    `<script>
      let restored=false;
      try {
        const saved=localStorage.getItem('__owQaSettingsBackup');
        if(saved){const {value}=JSON.parse(saved);if(value===null)localStorage.removeItem('ow.settings.v1');else localStorage.setItem('ow.settings.v1',value);localStorage.removeItem('__owQaSettingsBackup');}
        restored=true;
      } finally {fetch('/__qa/restored/${id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({restored})});}
    </script>Restoring this QA origin's settings…`,
    { headers: { 'content-type': 'text/html' } },
  )
}
/** First native rAF must have occurred before the host permits the test touch. */
export function recordingAcknowledged(value: unknown): value is {
  stage: 'recording'
  recording: { running: true; frames: number }
  wall: number
} {
  const state = value as {
    stage?: string
    recording?: { running?: boolean; frames?: number }
    wall?: number
  } | null
  return Boolean(
    state?.stage === 'recording' &&
      state.recording?.running === true &&
      Number.isSafeInteger(state.recording.frames) &&
      (state.recording.frames ?? 0) > 0 &&
      Number.isFinite(state.wall),
  )
}
export function simulatorHost(api: string, directory: string, build: BuildReceipt) {
  localFixtureURL(api)
  const sessions = new Map<string, string>()
  const status = new Map<string, unknown>()
  const start = async (url: URL) => {
    const requested = url.searchParams.get('id')
    if (requested && !recordingId.test(requested)) {
      return new Response('Invalid recording id', { status: 400 })
    }
    const id = requested ?? crypto.randomUUID()
    if (sessions.has(id) || status.has(id)) {
      return new Response('Recording id already used', { status: 409 })
    }
    requireLocalPerformanceFixture(
      api,
      await (await fetch(`${api}/__test/performance-config`)).json(),
    )
    const response = await fetch(`${api}/__test/seed`)
    if (!response.ok) {
      return new Response('Local Worker unavailable', { status: 503 })
    }
    const account = (await response.json()) as { accountId: string; token: string }
    sessions.set(id, account.accountId)
    const credentials = JSON.stringify({ api, token: account.token }).replaceAll('<', '\\u003c')
    const setup = JSON.stringify({
      id,
      stress: url.searchParams.get('population') === 'stress',
      preflight: url.searchParams.get('preflight') === '1',
    })
    return new Response(
      `<html><head><script>sessionStorage.setItem('__owQaAccount',JSON.stringify(${credentials}));sessionStorage.setItem('__owQaRecording',JSON.stringify(${setup}));location.replace('/experiments/out-west/frontier/?server=remote')</script></head><body>Preparing local qualification scene…</body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )
  }
  const session = async (request: Request, id: string, accountId: string) => {
    const body = (await request.json()) as {
      action: string
      lobbyId: string
      page?: unknown
      recording?: unknown
    }
    if (body.action === 'ready') {
      status.set(id, { stage: 'ready', page: body.page })
      return Response.json({ ok: true })
    }
    if (body.action === 'recording') {
      const value = { stage: 'recording', recording: body.recording, wall: Date.now() }
      if (!recordingAcknowledged(value)) {
        return new Response('Native recorder has not started', { status: 409 })
      }
      status.set(id, value)
      return Response.json({ ok: true })
    }
    if (!['start', 'finish', 'pack'].includes(body.action)) {
      return new Response('Invalid fixture action', { status: 400 })
    }
    const response = await fetch(
      `${api}/__test/${body.action === 'pack' ? 'packed-town' : 'performance'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, lobbyId: body.lobbyId, start: body.action === 'start' }),
      },
    )
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  const save = async (request: Request, id: string) => {
    const body = (await request.json()) as { recording: { timestamps: number[] } }
    const receipt = {
      ...body,
      build,
      physicalDevice: false,
      qualification: 'incomplete',
      outstandingEvidence: [
        'Guest native foreground/visibility and headless simulator identity require independent joining; no Mac foreground claim',
      ],
      timing: frameTiming(body.recording.timestamps),
    }
    const path = join(directory, `simulator-${id}.json`)
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`)
    status.set(id, { stage: 'saved', receipt })
    sessions.delete(id)
    console.log(`Simulator recording saved: ${path}`)
    return Response.json({ saved: true })
  }
  const readStatus = (id: string) =>
    status.has(id) ? Response.json(status.get(id)) : new Response('Not ready', { status: 404 })
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname === '/__qa/restore') {
      return restorePage(url.searchParams.get('id') ?? '')
    }
    if (url.pathname === '/__qa/start') {
      return start(url)
    }
    const parts = url.pathname.split('/')
    const id = parts[3] ?? ''
    if (parts[1] !== '__qa' || !recordingId.test(id)) {
      return null
    }
    if (parts[2] === 'restored' && request.method === 'POST') {
      const body = (await request.json()) as { restored?: boolean }
      status.set(id, {
        ...((status.get(id) as object | undefined) ?? {}),
        settingsRestored: body.restored === true,
      })
      return Response.json({ ok: true })
    }
    if (parts[2] === 'status' && request.method === 'GET') {
      return readStatus(id)
    }
    const accountId = sessions.get(id)
    if (!accountId || request.method !== 'POST') {
      return null
    }
    if (parts[2] === 'session') {
      return session(request, id, accountId)
    }
    if (parts[2] === 'receipt') {
      return save(request, id)
    }
    return null
  }
}
