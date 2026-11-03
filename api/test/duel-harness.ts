/**
 * Bounty Hunt end-to-end harness: simulated clients over real WebSockets against `wrangler dev`.
 *
 *   bunx wrangler d1 migrations apply contra-leaderboard --config api/wrangler.jsonc --local
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8792 --inspector-port 9232
 *   bun api/test/duel-harness.ts [http://localhost:8792]
 *
 * It seeds accounts straight into the local D1 file (stream A's tables are stubbed until it lands),
 * then proves: a human-vs-human duel, a rematch with a dead heat and sudden death, a coward, a
 * forfeit on disconnect, a ghost duel (with the owner's royalty), and the same-network rule. It
 * checks the ledger and match rows after each.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/style/noProcessGlobal: a CLI harness sets its exit code
// biome-ignore-all lint/performance/noAwaitInLoops: scenarios run strictly in order
import { Database } from 'bun:sqlite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DuelResult,
  QueueServerMessage,
  RoomClientMessage,
  RoomServerMessage,
} from '../../src/experiments/out-west/contract/duel.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'

const BASE = Bun.argv[2] ?? 'http://localhost:8792'
const ORIGIN = 'http://localhost:4321'
const D1_DIR = join(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const RUN = Date.now().toString(36)

// --- local D1 ------------------------------------------------------------------------------------

function openD1(): Database {
  const file = readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'))
  if (!file) {
    throw new Error(`No local D1 in ${D1_DIR}. Apply the migrations first.`)
  }
  const db = new Database(join(D1_DIR, file))
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)')
  return db
}

const db = openD1()

interface Player {
  id: string
  name: string
  token: string
  ip: string
}

let seq = 0
function seedPlayer(name: string, ip: string, purse = 1000): Player {
  const id = `h${RUN}${++seq}`
  const display = `${name}${seq}`
  const now = Date.now()
  db.query('INSERT INTO accounts (id, name) VALUES (?, ?)').run(id, display)
  db.query(
    `INSERT INTO profiles (account_id, level, xp, prestige, purse, loadout, gauntlet_clears, created_at, updated_at)
     VALUES (?, 1, 0, 0, ?, ?, 7, ?, ?)`,
  ).run(id, purse, JSON.stringify(DEFAULT_LOADOUT), now, now)
  db.query(
    `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
     VALUES (?, ?, 0, ?, 'start_grant', 'harness', ?, 'harness', ?)`,
  ).run(id, purse, purse, `harness:${id}`, now)
  return { id, name: display, token: `dev:${id}:${display}`, ip }
}

function seedGhost(owner: Player, reactions: number[]): void {
  const now = Date.now()
  db.query(
    `INSERT INTO ghost_profiles (account_id, name, level, prestige, draw_rating, loadout, duels, samples, updated_at)
     VALUES (?, ?, 1, 0, 260, ?, 40, ?, ?)`,
  ).run(owner.id, owner.name, JSON.stringify(DEFAULT_LOADOUT), reactions.length, now)
  for (const ms of reactions) {
    db.query("INSERT INTO ghost_samples (account_id, ms, source, created_at) VALUES (?, ?, 'pvp', ?)").run(
      owner.id,
      ms,
      now,
    )
  }
}

const purse = (p: Player): number =>
  (db.query('SELECT purse FROM profiles WHERE account_id = ?').get(p.id) as { purse: number }).purse

const ledger = (p: Player): { kind: string; delta: number; xp: number; idem_key: string }[] =>
  db
    .query("SELECT kind, delta, xp, idem_key FROM ledger WHERE account_id = ? AND kind != 'start_grant' ORDER BY id")
    .all(p.id) as { kind: string; delta: number; xp: number; idem_key: string }[]

const matchRow = (roomId: string, rematch = 0): Record<string, unknown> | null =>
  db.query('SELECT * FROM matches WHERE id = ?').get(`${roomId}:${rematch}`) as Record<string, unknown> | null

// --- assertions ----------------------------------------------------------------------------------

let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) {
    failures++
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- the simulated client ------------------------------------------------------------------------

type Behaviour = {
  /** Fire this long after the call (ms), reporting it as localMs. Null never fires. */
  reactMs: number | null
  /** Fire during the wait (cowardice). */
  coward?: boolean
  /** Drop the socket once the walk starts. */
  dropOnWalk?: boolean
  /** Vote for a rematch after the first result, and use `rematchReactMs` then. */
  rematch?: boolean
  rematchReactMs?: number
}

class Client {
  readonly messages: RoomServerMessage[] = []
  readonly results: DuelResult[] = []
  private room: WebSocket | null = null
  matchId = ''
  mode = ''

  constructor(
    readonly player: Player,
    private behaviour: Behaviour,
  ) {}

  async queue(opts: { ghostNow?: boolean; leaveAfterMs?: number } = {}): Promise<string | null> {
    const res = await fetch(`${BASE}/queue/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${this.player.token}` },
      body: JSON.stringify({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
    })
    const { wsUrl } = (await res.json()) as { wsUrl: string }
    const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN, 'X-Dev-Ip': this.player.ip } } as unknown as string[])
    return await new Promise((resolve) => {
      const timer = opts.leaveAfterMs
        ? setTimeout(() => {
            ws.send(JSON.stringify({ type: 'leave' }))
            resolve(null)
          }, opts.leaveAfterMs)
        : undefined
      ws.addEventListener('message', (event) => {
        const m = JSON.parse(String(event.data)) as QueueServerMessage
        if (m.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', n: m.n }))
        } else if (m.type === 'status' && m.ghostButton && opts.ghostNow) {
          ws.send(JSON.stringify({ type: 'ghost' }))
        } else if (m.type === 'matched') {
          clearTimeout(timer)
          this.matchId = m.matchId
          this.mode = m.mode
          resolve(m.wsUrl)
        } else if (m.type === 'refused' || m.type === 'error') {
          console.log('    queue:', m)
          clearTimeout(timer)
          resolve(null)
        }
      })
    })
  }

  private send(m: RoomClientMessage): void {
    try {
      this.room?.send(JSON.stringify(m))
    } catch {
      // closed
    }
  }

  join(wsUrl: string): void {
    const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } } as unknown as string[])
    this.room = ws
    let callAt = 0
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data)) as RoomServerMessage
      this.messages.push(m)
      this.onMessage(m, () => callAt, (t) => {
        callAt = t
      })
    })
  }

  private onMessage(m: RoomServerMessage, callAt: () => number, setCall: (t: number) => void): void {
    const b = this.behaviour
    switch (m.type) {
      case 'ping':
        this.send({ type: 'pong', n: m.n })
        return
      case 'beat':
        if (m.beat === 'cock') {
          setTimeout(() => this.send({ type: 'ready' }), 100)
        } else if (m.beat === 'walk') {
          if (b.dropOnWalk) {
            this.room?.close()
            return
          }
          this.send({ type: 'hold', down: true })
        } else if (m.beat === 'wait' && b.coward) {
          setTimeout(() => this.send({ type: 'shot', draw: this.drawOf(), localMs: null }), 600)
        }
        return
      case 'call': {
        setCall(performance.now())
        const react = this.results.length > 0 && b.rematchReactMs !== undefined ? b.rematchReactMs : b.reactMs
        if (react !== null) {
          setTimeout(() => this.send({ type: 'shot', draw: m.draw, localMs: performance.now() - callAt() }), react)
        }
        return
      }
      case 'result':
        this.results.push(m)
        if (b.rematch && this.results.length === 1) {
          setTimeout(() => this.send({ type: 'rematch' }), 300)
        }
        return
      default:
        return
    }
  }

  private drawOf(): number {
    const sync = [...this.messages].reverse().find((m) => m.type === 'sync')
    return sync?.type === 'sync' ? sync.draw + 1 : 1
  }

  async waitFor(pred: () => boolean, timeoutMs = 40_000): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (pred()) {
        return true
      }
      await sleep(100)
    }
    return pred()
  }

  close(): void {
    this.room?.close()
  }
}

async function duel(a: Client, b: Client): Promise<string> {
  const [ua, ub] = await Promise.all([a.queue(), b.queue()])
  if (!(ua && ub)) {
    throw new Error('queue failed')
  }
  a.join(ua)
  b.join(ub)
  return a.matchId
}

// --- scenarios -----------------------------------------------------------------------------------

async function humanVsHumanWithRematchAndDeadHeat(): Promise<void> {
  console.log('\n1. Human vs human, then a rematch with a dead heat and sudden death')
  const a = new Client(seedPlayer('Quick', '10.1.0.1'), { reactMs: 200, rematch: true, rematchReactMs: 230 })
  const b = new Client(seedPlayer('Slow', '10.2.0.1'), { reactMs: 320, rematch: true, rematchReactMs: 230 })
  const room = await duel(a, b)
  check('both matched into the same room', a.matchId === b.matchId && a.mode === 'pvp', [a.matchId, b.matchId])
  await a.waitFor(() => a.results.length >= 1)
  const first = a.results[0]
  check('the faster draw wins', first?.outcome === 'win' && first.winner === 0, first)
  check('the result is settled with money for the winner', first?.settled === true && (first.you?.delta ?? 0) > 0, first?.you)
  check('the walk paced between 5 and 9 steps', a.messages.filter((m) => m.type === 'pace').length >= 5)
  const row = matchRow(room)
  check('match row committed', row?.outcome === 'win' && row.winner === 'a', row)
  check('winner ledger: duel_win rows keyed match:<id>', ledger(a.player).some((l) => l.kind === 'duel_win' && l.idem_key.startsWith(`match:${room}:0`)))
  check('loser ledger: duel_loss with a negative delta', ledger(b.player).some((l) => l.kind === 'duel_loss' && l.delta < 0))
  check('purses moved', purse(a.player) > 1000 && purse(b.player) < 1000, [purse(a.player), purse(b.player)])

  // Rematch: both fire at the same instant, so the first draw is a dead heat.
  await a.waitFor(() => a.results.length >= 2, 60_000)
  const hello = a.messages.filter((m) => m.type === 'hello')
  check('rematch started with hello rematch=1 (no intro)', hello.some((m) => m.type === 'hello' && m.rematch === 1))
  const heats = a.messages.filter((m) => m.type === 'deadHeat')
  check('a dead heat was called and sudden death followed', heats.length >= 1 && a.messages.some((m) => m.type === 'suddenDeath'), heats)
  const second = a.results[1]
  check('the rematch ended in a double dead heat draw', second?.outcome === 'draw' && second.deadHeats === 2, second)
  check('rematch row committed with dead heats', matchRow(room, 1)?.dead_heats === 2, matchRow(room, 1))
  a.close()
  b.close()
}

async function coward(): Promise<void> {
  console.log('\n2. A coward draws during the wait')
  const a = new Client(seedPlayer('Honest', '10.3.0.1'), { reactMs: 250 })
  const b = new Client(seedPlayer('Yellow', '10.4.0.1'), { reactMs: null, coward: true })
  const room = await duel(a, b)
  await a.waitFor(() => a.results.length >= 1)
  const r = a.results[0]
  check('outcome coward, culprit seat 1, honest seat wins', r?.outcome === 'coward' && r.culprit === 1 && r.winner === 0, r)
  check('the coward is charged', ledger(b.player).some((l) => l.kind === 'duel_loss' && l.delta < 0))
  const stats = db.query('SELECT cowardice FROM duel_stats WHERE account_id = ?').get(b.player.id) as { cowardice: number } | null
  check('the cowardice tally went up', stats?.cowardice === 1, stats)
  check('match row says coward', matchRow(room)?.outcome === 'coward')
  a.close()
  b.close()
}

async function forfeit(): Promise<void> {
  console.log('\n3. A player drops before the call and does not come back: forfeit')
  const a = new Client(seedPlayer('Stayer', '10.5.0.1'), { reactMs: 250 })
  const b = new Client(seedPlayer('Quitter', '10.6.0.1'), { reactMs: 250, dropOnWalk: true })
  const room = await duel(a, b)
  const presence = await a.waitFor(() => a.messages.some((m) => m.type === 'presence' && !m.connected))
  check('the opponent saw the drop with a grace deadline', presence)
  await a.waitFor(() => a.results.length >= 1)
  const r = a.results[0]
  check('forfeit after the 5 s grace', r?.outcome === 'forfeit' && r.culprit === 1 && r.winner === 0, r)
  check('forfeit charged a full loss', ledger(b.player).some((l) => l.kind === 'duel_loss' && l.delta < 0))
  check('match row says forfeit', matchRow(room)?.outcome === 'forfeit')
  a.close()
}

async function ghostDuel(): Promise<void> {
  console.log('\n4. Ghost duel (no human in range: ghost button at 8 s)')
  const owner = seedPlayer('Ghostly', '10.7.0.1', 500)
  seedGhost(owner, Array.from({ length: 20 }, (_, i) => 330 + (i % 5) * 10))
  const ownerBefore = purse(owner)
  // A fast human beats this ghost; then a rematch where the human freezes, so the ghost wins.
  const h = new Client(seedPlayer('Lonely', '10.8.0.1'), { reactMs: 180, rematch: true, rematchReactMs: 5000 })
  const url = await h.queue({ ghostNow: true })
  check('matched with a ghost', url !== null && h.mode === 'ghost')
  if (!url) {
    return
  }
  h.join(url)
  await h.waitFor(() => h.results.length >= 1)
  const hello = h.messages.find((m) => m.type === 'hello')
  check('the ghost poster is labelled', hello?.type === 'hello' && hello.posters[1].kind === 'ghost', hello)
  const r = h.results[0]
  check('the human beat the ghost', r?.outcome === 'win' && r.winner === 0, r)
  check('ghost_win ledger entry', ledger(h.player).some((l) => l.kind === 'ghost_win' && l.delta > 0))
  await h.waitFor(() => h.results.length >= 2, 60_000)
  const r2 = h.results[1]
  check('in the rematch the ghost won', r2?.winner === 1, r2)
  check('the ghost owner earned a royalty', purse(owner) > ownerBefore && ledger(owner).some((l) => l.kind === 'ghost_royalty'), ledger(owner))
  const samples = db.query('SELECT COUNT(*) AS n FROM ghost_samples WHERE account_id = ?').get(h.player.id) as { n: number }
  check("the human's own ghost recorded a sample", samples.n >= 1, samples)
  h.close()
}

async function sameNetwork(): Promise<void> {
  console.log('\n5. Same network (same /24) never pairs')
  const a = new Client(seedPlayer('Roomie', '10.9.0.1'), { reactMs: 250 })
  const b = new Client(seedPlayer('Roomie', '10.9.0.2'), { reactMs: 250 })
  const [ua, ub] = await Promise.all([a.queue({ leaveAfterMs: 5000 }), b.queue({ leaveAfterMs: 5000 })])
  check('no match within 5 s for two players on one /24', ua === null && ub === null, [ua, ub])
}

const scenarios = [humanVsHumanWithRematchAndDeadHeat, coward, forfeit, ghostDuel, sameNetwork]
for (const scenario of scenarios) {
  try {
    await scenario()
  } catch (err) {
    check(`${scenario.name} threw`, false, String(err))
  }
}
console.log(failures === 0 ? '\nAll Bounty Hunt scenarios passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
