/**
 * Bounty Hunt end-to-end harness: simulated clients over real WebSockets against `wrangler dev`.
 *
 *   bunx wrangler d1 migrations apply contra-leaderboard --config api/wrangler.jsonc --local
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8792 --inspector-port 9232
 *   bun api/test/duel-harness.ts [http://localhost:8792]
 *
 * It seeds accounts and profiles straight into the local D1 file and mints real access tokens with
 * the dev `AUTH_SECRET` from `api/.dev.vars`, then proves: a human-vs-human duel, a rematch with a dead heat and sudden death, a coward, a
 * forfeit on disconnect, a ghost duel (with the owner's royalty), and the same-network rule. It
 * checks the ledger and match rows after each.
 */
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { signAccessToken } from '../src/auth/token.ts'
import { nameKey } from '../src/names.ts'
import { BASE, Client, ORIGIN, type Player, sleep, waitFor } from './duel-client.ts'

const D1_DIR = join(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const RUN = Date.now().toString(36)
const SECRET =
  /^AUTH_SECRET=(?<s>.+)$/mu.exec(readFileSync(join(import.meta.dir, '../.dev.vars'), 'utf8'))
    ?.groups?.s ?? ''

// --- local D1 ------------------------------------------------------------------------------------

function openD1(): Database {
  const file = readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'))
  if (!file) {
    throw new Error(`No local D1 in ${D1_DIR}. Apply the migrations first.`)
  }
  const db = new Database(join(D1_DIR, file))
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

const db = openD1()

let seq = 0
async function seedPlayer(name: string, ip: string, startPurse = 1000): Promise<Player> {
  const id = `h${RUN}${++seq}`
  const display = `${name} ${RUN.slice(-4)}${seq}`
  const now = Date.now()
  db.query('INSERT INTO accounts (id, name, name_key, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    display,
    nameKey(display),
    now,
  )
  db.query(
    `INSERT INTO profiles (account_id, level, xp, prestige, purse, loadout, gauntlet_clears, created_at, updated_at)
     VALUES (?, 1, 0, 0, ?, ?, 7, ?, ?)`,
  ).run(id, startPurse, JSON.stringify(DEFAULT_LOADOUT), now, now)
  db.query(
    `INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
     VALUES (?, ?, 0, ?, 'start_grant', 'harness', ?, 'harness', ?)`,
  ).run(id, startPurse, startPurse, `harness:${id}`, now)
  const { token } = await signAccessToken(SECRET, {
    accountId: id,
    name: display,
    sid: `harness-${id}`,
    platform: 'web',
    authTime: now,
  })
  return { id, name: display, token, ip }
}

function seedGhost(owner: Player, reactions: number[]): void {
  const now = Date.now()
  db.query(
    `INSERT INTO ghost_profiles (account_id, name, level, prestige, draw_rating, loadout, duels, samples, updated_at)
     VALUES (?, ?, 1, 0, 260, ?, 40, ?, ?)`,
  ).run(owner.id, owner.name, JSON.stringify(DEFAULT_LOADOUT), reactions.length, now)
  for (const ms of reactions) {
    db.query(
      "INSERT INTO ghost_samples (account_id, ms, source, created_at) VALUES (?, ?, 'pvp', ?)",
    ).run(owner.id, ms, now)
  }
}

const purse = (p: Player): number =>
  (db.query('SELECT purse FROM profiles WHERE account_id = ?').get(p.id) as { purse: number }).purse

const ledger = (p: Player): { kind: string; delta: number; xp: number; idem_key: string }[] =>
  db
    .query(
      "SELECT kind, delta, xp, idem_key FROM ledger WHERE account_id = ? AND kind != 'start_grant' ORDER BY id",
    )
    .all(p.id) as { kind: string; delta: number; xp: number; idem_key: string }[]

const matchRow = (roomId: string, rematch = 0): Record<string, unknown> | null =>
  db.query('SELECT * FROM matches WHERE id = ?').get(`${roomId}:${rematch}`) as Record<
    string,
    unknown
  > | null

// --- assertions ----------------------------------------------------------------------------------

let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) {
    failures++
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
  const a = new Client(await seedPlayer('Quick', '10.1.0.1'), {
    reactMs: 200,
    rematch: true,
    rematchReactMs: 230,
  })
  const b = new Client(await seedPlayer('Slow', '10.2.0.1'), {
    reactMs: 320,
    rematch: true,
    rematchReactMs: 230,
  })
  const room = await duel(a, b)
  check('both matched into the same room', a.matchId === b.matchId && a.mode === 'pvp', [
    a.matchId,
    b.matchId,
  ])
  await waitFor(() => a.results.length > 0)
  const first = a.results[0]
  check('the faster draw wins', first?.outcome === 'win' && first.winner === a.seat, first)
  check(
    'the result is settled with money for the winner',
    first?.settled === true && (first.you?.delta ?? 0) > 0,
    first?.you,
  )
  check(
    'the walk paced between 5 and 9 steps',
    a.messages.filter((m) => m.type === 'pace').length >= 5,
  )
  const row = matchRow(room)
  check(
    'match row committed',
    row?.outcome === 'win' && row.winner === (a.seat === 0 ? 'a' : 'b'),
    row,
  )
  check(
    'winner ledger: duel_win rows keyed match:<id>',
    ledger(a.player).some((l) => l.kind === 'duel_win' && l.idem_key.startsWith(`match:${room}:0`)),
  )
  check(
    'loser ledger: duel_loss with a negative delta',
    ledger(b.player).some((l) => l.kind === 'duel_loss' && l.delta < 0),
  )
  check('purses moved', purse(a.player) > 1000 && purse(b.player) < 1000, [
    purse(a.player),
    purse(b.player),
  ])

  // Rematch: both fire at the same instant, so the first draw is a dead heat.
  await waitFor(() => a.results.length >= 2, 60_000)
  const hello = a.messages.filter((m) => m.type === 'hello')
  check(
    'rematch started with hello rematch=1 (no intro)',
    hello.some((m) => m.type === 'hello' && m.rematch === 1),
  )
  const heats = a.messages.filter((m) => m.type === 'deadHeat')
  check(
    'a dead heat was called and sudden death followed',
    heats.length > 0 && a.messages.some((m) => m.type === 'suddenDeath'),
    heats,
  )
  const second = a.results[1]
  check(
    'the rematch ended in a double dead heat draw',
    second?.outcome === 'draw' && second.deadHeats === 2,
    second,
  )
  check(
    'rematch row committed with dead heats',
    matchRow(room, 1)?.dead_heats === 2,
    matchRow(room, 1),
  )
  a.close()
  b.close()
}

async function coward(): Promise<void> {
  console.log('\n2. A coward draws during the wait')
  const a = new Client(await seedPlayer('Honest', '10.3.0.1'), { reactMs: 250 })
  const b = new Client(await seedPlayer('Yellow', '10.4.0.1'), { reactMs: null, coward: true })
  const room = await duel(a, b)
  await waitFor(() => a.results.length > 0)
  const r = a.results[0]
  check(
    'outcome coward: the coward is the culprit, the honest seat wins',
    r?.outcome === 'coward' && r.culprit === b.seat && r.winner === a.seat,
    r,
  )
  check(
    'the coward is charged',
    ledger(b.player).some((l) => l.kind === 'duel_loss' && l.delta < 0),
  )
  const stats = db
    .query('SELECT cowardice FROM duel_stats WHERE account_id = ?')
    .get(b.player.id) as { cowardice: number } | null
  check('the cowardice tally went up', stats?.cowardice === 1, stats)
  check('match row says coward', matchRow(room)?.outcome === 'coward')
  a.close()
  b.close()
}

async function forfeit(): Promise<void> {
  console.log('\n3. A player drops before the call and does not come back: forfeit')
  const a = new Client(await seedPlayer('Stayer', '10.5.0.1'), { reactMs: 250 })
  const b = new Client(await seedPlayer('Quitter', '10.6.0.1'), { reactMs: 250, dropOnWalk: true })
  const room = await duel(a, b)
  const presence = await waitFor(() =>
    a.messages.some((m) => m.type === 'presence' && !m.connected),
  )
  check('the opponent saw the drop with a grace deadline', presence)
  await waitFor(() => a.results.length > 0)
  const r = a.results[0]
  check(
    'forfeit after the 5 s grace',
    r?.outcome === 'forfeit' && r.culprit === b.seat && r.winner === a.seat,
    r,
  )
  check(
    'forfeit charged a full loss',
    ledger(b.player).some((l) => l.kind === 'duel_loss' && l.delta < 0),
  )
  check('match row says forfeit', matchRow(room)?.outcome === 'forfeit')
  a.close()
}

async function ghostDuel(): Promise<void> {
  console.log('\n4. Ghost duel (no human in range: ghost button at 8 s)')
  const owner = await seedPlayer('Ghostly', '10.7.0.1', 500)
  seedGhost(
    owner,
    Array.from({ length: 20 }, (_, i) => 330 + (i % 5) * 10),
  )
  // Ghosts left by earlier harness runs are eligible too, so the royalty is checked against
  // whichever owner the matchmaker picked (by the match's ghost_of).
  // A fast human beats this ghost; then a rematch where the human freezes, so the ghost wins.
  const h = new Client(await seedPlayer('Lonely', '10.8.0.1'), {
    reactMs: 180,
    rematch: true,
    rematchReactMs: 5000,
  })
  const url = await h.queue({ ghostNow: true })
  check('matched with a ghost', url !== null && h.mode === 'ghost')
  if (!url) {
    return
  }
  h.join(url)
  await waitFor(() => h.results.length > 0)
  const hello = h.messages.find((m) => m.type === 'hello')
  check(
    'the ghost poster is labelled',
    hello?.type === 'hello' && hello.posters[1].kind === 'ghost',
    hello,
  )
  const r = h.results[0]
  check('the human beat the ghost', r?.outcome === 'win' && r.winner === 0, r)
  check(
    'ghost_win ledger entry',
    ledger(h.player).some((l) => l.kind === 'ghost_win' && l.delta > 0),
  )
  await waitFor(() => h.results.length >= 2, 60_000)
  const r2 = h.results[1]
  check('in the rematch the ghost won', r2?.winner === 1, r2)
  const ghostOf = matchRow(h.matchId, 1)?.ghost_of
  const royalty = db
    .query("SELECT account_id, delta FROM ledger WHERE kind = 'ghost_royalty' AND ref = ?")
    .get(`${h.matchId}:1`) as { account_id: string; delta: number } | null
  check(
    'the ghost owner earned a royalty',
    royalty !== null && royalty.account_id === ghostOf && royalty.delta >= 5,
    { ghostOf, royalty },
  )
  const samples = db
    .query('SELECT COUNT(*) AS n FROM ghost_samples WHERE account_id = ?')
    .get(h.player.id) as { n: number }
  check("the human's own ghost recorded a sample", samples.n >= 1, samples)
  h.close()
}

async function sameNetwork(): Promise<void> {
  console.log('\n5. Same network (same /24) never pairs')
  const a = new Client(await seedPlayer('Roomie', '10.9.0.1'), { reactMs: 250 })
  const b = new Client(await seedPlayer('Roomie', '10.9.0.2'), { reactMs: 250 })
  const [ua, ub] = await Promise.all([
    a.queue({ leaveAfterMs: 5000 }),
    b.queue({ leaveAfterMs: 5000 }),
  ])
  check('no match within 5 s for two players on one /24', ua === null && ub === null, [ua, ub])
}

async function signedInRanked(): Promise<void> {
  console.log('\n6. A signed-in ranked run pays a gauntlet first clear through the ledger')
  const p = await seedPlayer('Ranked', '10.10.0.1')
  db.query('UPDATE profiles SET gauntlet_clears = 0 WHERE account_id = ?').run(p.id)
  const res = await fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Authorization: `Bearer ${p.token}`,
    },
    body: JSON.stringify({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
  })
  const { wsUrl } = (await res.json()) as { wsUrl: string }
  const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } } as unknown as string[])
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let callAt = 0
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data)) as Record<string, unknown> & { type: string }
      if (m.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', n: m.n }))
      } else if (m.type === 'hello') {
        setTimeout(() => ws.send(JSON.stringify({ type: 'standoff', duel: 0, level: 0 })), 1200)
      } else if (m.type === 'call') {
        // the call comes `inMs` ahead of itself: react from when it's presented
        const lead = typeof m.inMs === 'number' ? m.inMs : 0
        callAt = performance.now() + lead
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                type: 'shot',
                duel: 0,
                target: 0,
                localMs: performance.now() - callAt,
              }),
            ),
          lead + 230,
        )
      } else if (m.type === 'result') {
        resolve(m)
      }
    })
  })
  check('ranked win', result.outcome === 'win', result)
  await sleep(500)
  const grant = ledger(p).find((l) => l.kind === 'gauntlet_clear')
  check(
    'gauntlet_clear ledger entry for the signed-in run',
    grant !== undefined && grant.xp > 0,
    ledger(p),
  )
  ws.close()
}

const scenarios = [
  humanVsHumanWithRematchAndDeadHeat,
  coward,
  forfeit,
  ghostDuel,
  sameNetwork,
  signedInRanked,
]
const only = process.argv[3]
for (const scenario of scenarios.filter((x) => !only || x.name === only)) {
  try {
    await scenario()
  } catch (err) {
    check(`${scenario.name} threw`, false, String(err))
  }
}
console.log(
  failures === 0 ? '\nAll Bounty Hunt scenarios passed.' : `\n${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
