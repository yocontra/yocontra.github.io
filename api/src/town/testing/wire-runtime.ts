/** Node's supported WebSocket transport drives a real workerd lobby for Bun's regression suite. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const [, , workerPath, migrations, current] = process.argv
if (!(workerPath && migrations && current)) {
  throw new Error('Expected worker bundle, migrations directory and current wire version')
}
const COMMENT_LINE = /^\s*--.*$/gmu
const STATEMENT_END = /;\s*$/mu
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    name: 'wire-test',
    modules: true,
    script: readFileSync(workerPath, 'utf8'),
    compatibilityDate: '2026-10-01',
    bindings: { RP_ID: 'localhost' },
    d1Databases: { DB: 'wire-rollout' },
    durableObjects: {
      LOBBIES: { className: 'Lobby', useSQLite: true },
      LOBBY_DIR: { className: 'LobbyDirectory', useSQLite: true },
    },
  }),
)

function headers(wire: string | undefined): Record<string, string> {
  return {
    Upgrade: 'websocket',
    'X-Lobby-Id': 'lobby:1',
    'X-Account-Id': 'local-wire-test',
    'X-Name': 'Rider',
    'X-Bots': '0',
    ...(wire === undefined ? {} : { 'X-Town-Wire-Version': wire }),
  }
}

async function currentControls(
  response: Awaited<ReturnType<Miniflare['dispatchFetch']>>,
): Promise<unknown[]> {
  const socket = response.webSocket
  if (!socket) {
    throw new Error('Current wire did not upgrade')
  }
  const controls: unknown[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Missing current town state')), 5000)
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          return
        }
        const control: unknown = JSON.parse(event.data)
        controls.push(control)
        if (
          typeof control === 'object' &&
          control !== null &&
          'type' in control &&
          control.type === 'town_state'
        ) {
          resolve()
        }
      })
      socket.accept()
    })
    return controls
  } finally {
    clearTimeout(timer)
    socket.close()
  }
}

try {
  const db = await runtime.getD1Database('DB')
  for (const name of readdirSync(migrations)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort()) {
    const statements = readFileSync(join(migrations, name), 'utf8')
      .replace(COMMENT_LINE, '')
      .split(STATEMENT_END)
      .map((statement) => statement.trim())
      .filter(Boolean)
    await db.batch(statements.map((statement) => db.prepare(statement)))
  }
  const refused: {
    wire: string | null
    status: number
    upgraded: boolean
    text: string
  }[] = []
  for (const wire of [
    undefined,
    String(Number(current) - 1),
    String(Number(current) + 1),
    '10.0',
    'invalid',
  ]) {
    const response = await runtime.dispatchFetch('http://local.test/ws', { headers: headers(wire) })
    refused.push({
      wire: wire ?? null,
      status: response.status,
      upgraded: response.webSocket !== null,
      text: await response.text(),
    })
  }
  const response = await runtime.dispatchFetch('http://local.test/ws', {
    headers: headers(current),
  })
  const controls = await currentControls(response)
  process.stdout.write(JSON.stringify({ refused, current: { status: response.status, controls } }))
} finally {
  await runtime.dispose()
}
