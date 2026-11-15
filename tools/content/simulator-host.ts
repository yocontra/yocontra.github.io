/** Same-origin local QA bootstrap and receipt sink for actual Simulator Safari. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { frameTiming } from './frame-timing.ts'
import type { BuildReceipt } from './production-fixture.ts'

export function simulatorHost(api: string, directory: string, build: BuildReceipt) {
  const sessions = new Map<string, string>()
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname === '/__qa/start') {
      const response = await fetch(`${api}/__test/seed`)
      if (!response.ok) {
        return new Response('Local Worker unavailable', { status: 503 })
      }
      const account = (await response.json()) as { accountId: string; token: string }
      const id = crypto.randomUUID()
      sessions.set(id, account.accountId)
      const credentials = JSON.stringify({ api, token: account.token }).replaceAll('<', '\\u003c')
      const setup = JSON.stringify({ id, stress: url.searchParams.get('population') === 'stress' })
      return new Response(
        `<html><head><script>sessionStorage.setItem('__owQaAccount',JSON.stringify(${credentials}));sessionStorage.setItem('__owQaRecording',JSON.stringify(${setup}));location.replace('/experiments/out-west/frontier/?server=remote')</script></head><body>Preparing local qualification scene…</body></html>`,
        { headers: { 'content-type': 'text/html' } },
      )
    }
    const parts = url.pathname.split('/')
    const id = parts[3] ?? ''
    const accountId = sessions.get(id)
    if (parts[1] !== '__qa' || !accountId || request.method !== 'POST') {
      return null
    }
    if (parts[2] === 'session') {
      const body = (await request.json()) as { action: string; lobbyId: string }
      if (!['start', 'finish', 'pack'].includes(body.action)) {
        return new Response('Invalid fixture action', { status: 400 })
      }
      const response = await fetch(
        `${api}/__test/${body.action === 'pack' ? 'packed-town' : 'performance'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            accountId,
            lobbyId: body.lobbyId,
            start: body.action === 'start',
          }),
        },
      )
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (parts[2] === 'receipt') {
      const body = (await request.json()) as { recording: { timestamps: number[] } }
      const receipt = {
        ...body,
        build,
        physicalDevice: false,
        qualification: 'incomplete',
        outstandingEvidence: [
          'Host foreground trace and simulator identity must be joined after capture',
        ],
        timing: frameTiming(body.recording.timestamps),
      }
      const path = join(directory, `simulator-${id}.json`)
      await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`)
      sessions.delete(id)
      console.log(`Simulator recording saved: ${path}`)
      return Response.json({ saved: true })
    }
    return null
  }
}
