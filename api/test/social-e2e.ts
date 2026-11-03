/**
 * End-to-end check, against a running `wrangler dev`, for the Most Wanted board, the money sinks,
 * public posters, reports and blocks, the Badlands and the Frontier licence gate:
 *
 * 1. A real Bounty Hunt duel puts its winner on this month's Most Wanted board with exactly the
 *    winnings the ledger booked (no start grant); a Badlands account drops off the board.
 * 2. Dye job, name change, a round for the house, a public poster.
 * 3. Players who block each other are never matched; unblocked, they are.
 * 4. A Badlands player is never matched with an honest one, only with another flagged player.
 * 5. Frontier: unlicensed → 403 `unlicensed`; licensed → a lobby; flagged → a Badlands lobby that
 *    the public directory never lists.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8799 --inspector-port 9239
 *   bun api/test/social-e2e.ts http://localhost:8799
 *
 * Not part of `bun test`. Seeds its own accounts straight into the local D1.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
import process from 'node:process'
import type {
  DyeResponse,
  MostWantedResponse,
} from '../../src/experiments/out-west/contract/economy.ts'
import type {
  BlocksResponse,
  ChalkboardResponse,
  NameChangeResponse,
  PlayerPoster,
} from '../../src/experiments/out-west/contract/social.ts'
import type {
  TownDirectoryView,
  TownJoinError,
  TownJoinResponse,
} from '../../src/experiments/out-west/contract/town.ts'
import { BASE, Client, ORIGIN, type Player, waitFor } from './duel-client.ts'
import { check, failed, openLocalD1, seedPlayer } from './local-d1.ts'

const db = openLocalD1()
let ipSeq = 0
const nextIp = (): string => `10.${120 + (++ipSeq % 100)}.${ipSeq}.1`

async function api<T>(
  method: string,
  path: string,
  opts: { as?: Player; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN }
  if (opts.as) {
    headers.Authorization = `Bearer ${opts.as.token}`
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? null : JSON.parse(text)) as T }
}

const flag = (p: Player): void => {
  db.query('UPDATE accounts SET flags = flags | 1 WHERE id = ?').run(p.id)
}

/** Both queue at once; true if they were matched with each other within 6 s. */
async function matched(a: Player, b: Player): Promise<boolean> {
  const [ca, cb] = [new Client(a, { reactMs: 200 }), new Client(b, { reactMs: 260 })]
  const [ua, ub] = await Promise.all([
    ca.queue({ leaveAfterMs: 6000 }),
    cb.queue({ leaveAfterMs: 6000 }),
  ])
  if (ua && ub) {
    ca.join(ua)
    cb.join(ub)
    await waitFor(() => ca.results.length > 0 && cb.results.length > 0, 60_000)
  }
  return ua !== null && ub !== null && ca.mode === 'pvp' && ca.matchId === cb.matchId
}

async function board(): Promise<void> {
  console.log('\n1. The monthly Most Wanted board')
  const a = await seedPlayer(db, { name: 'Earner', ip: nextIp() })
  const b = await seedPlayer(db, { name: 'Payer', ip: nextIp() })
  check('a duel matches them', await matched(a, b))
  const credits = db
    .query(
      `SELECT COALESCE(SUM(delta), 0) AS earned FROM ledger WHERE account_id = ? AND delta > 0
       AND kind IN ('duel_win', 'level_reward')`,
    )
    .get(a.id) as { earned: number }
  const res = await api<MostWantedResponse>('GET', '/board/most-wanted?limit=50', { as: a })
  check('GET /board/most-wanted answers', res.status === 200, res)
  const row = res.body.rows.find((r) => r.name === a.name)
  check(
    "the winner's earnings are exactly the ledger's credits (no start grant)",
    row?.earned === credits.earned && credits.earned > 0,
    { row, credits },
  )
  check('your own rank is included', res.body.you?.earned === credits.earned, res.body.you)
  check('the previous month is reported', typeof res.body.previous.month === 'string')
  flag(a)
  const after = await api<MostWantedResponse>('GET', '/board/most-wanted?limit=50')
  check('a Badlands account drops off the board', !after.body.rows.some((r) => r.name === a.name))
}

async function sinks(): Promise<void> {
  console.log('\n2. Dye, name change, a round for the house, a public poster')
  const p = await seedPlayer(db, { name: 'Spender', ip: nextIp(), purse: 10_000 })
  db.query(
    "INSERT INTO inventory (account_id, item_id, source, acquired_at) VALUES (?, 'hat.battered-brim', 'starter', ?)",
  ).run(p.id, Date.now())
  const dye = await api<DyeResponse>('POST', '/store/dye', {
    as: p,
    body: { itemId: 'hat.battered-brim', dye: 'indigo' },
  })
  check('dye job: $500, purse charged', dye.status === 200 && dye.body.purse === 9500, dye)
  const newName = `Renamed ${p.name.slice(-5)}`
  const name = await api<NameChangeResponse>('POST', '/me/name', { as: p, body: { name: newName } })
  check('name change: $5,000', name.status === 200 && name.body.purse === 4500, name)
  const round = await api<{ purse: number }>('POST', '/saloon/round', { as: p })
  check('a round for the house: $1,000', round.status === 200 && round.body.purse === 3500, round)
  const chalk = await api<ChalkboardResponse>('GET', '/saloon/chalkboard')
  check('the chalkboard shows the new name', chalk.body.rounds[0]?.name === newName, chalk.body)
  const poster = await api<PlayerPoster>('GET', `/players/${encodeURIComponent(newName)}`)
  check(
    'GET /players/:name shows the poster with the dye',
    poster.status === 200 && poster.body.dyes['hat.battered-brim'] === 'indigo',
    poster.body,
  )
  const ledger = db
    .query('SELECT SUM(delta) AS sum FROM ledger WHERE account_id = ?')
    .get(p.id) as { sum: number }
  const purse = db.query('SELECT purse FROM profiles WHERE account_id = ?').get(p.id) as {
    purse: number
  }
  check('ledger sum equals the purse', ledger.sum === purse.purse, { ledger, purse })
}

async function blocks(): Promise<void> {
  console.log('\n3. Blocked players are never matched')
  const c = await seedPlayer(db, { name: 'Blocker', ip: nextIp() })
  const d = await seedPlayer(db, { name: 'Blocked', ip: nextIp() })
  const added = await api<BlocksResponse>('POST', '/blocks', { as: c, body: { name: d.name } })
  check('POST /blocks', added.status === 200 && added.body.blocked.includes(d.name), added)
  check('no match while one blocks the other', !(await matched(c, d)))
  const removed = await api<BlocksResponse>('DELETE', `/blocks/${encodeURIComponent(d.name)}`, {
    as: c,
  })
  check('DELETE /blocks/:name', removed.body.blocked.length === 0, removed)
  check('unblocked, they are matched', await matched(c, d))
}

async function badlands(): Promise<void> {
  console.log('\n4. The Badlands shadow pool')
  const honest = await seedPlayer(db, { name: 'Honest', ip: nextIp() })
  const cheat = await seedPlayer(db, { name: 'Cheat', ip: nextIp() })
  const cheat2 = await seedPlayer(db, { name: 'Cheat', ip: nextIp() })
  flag(cheat)
  flag(cheat2)
  check('a flagged player is never matched with an honest one', !(await matched(honest, cheat)))
  check('two flagged players are matched with each other', await matched(cheat, cheat2))
}

async function frontier(): Promise<void> {
  console.log('\n5. Frontier: the licence gate and the Badlands lobby')
  const rookie = await seedPlayer(db, { name: 'Rookie', ip: nextIp(), clears: 0b011 })
  const refused = await api<TownJoinError>('POST', '/town/join', { as: rookie, body: {} })
  check(
    'unlicensed: 403 with reason and progress',
    refused.status === 403 &&
      refused.body.reason === 'unlicensed' &&
      refused.body.licence?.remaining === 1 &&
      refused.body.error.length > 0,
    refused,
  )
  const rider = await seedPlayer(db, { name: 'Rider', ip: nextIp() })
  const ok = await api<TownJoinResponse>('POST', '/town/join', { as: rider, body: {} })
  const n = Number(ok.body.lobbyId.split(':')[1])
  check('licensed: a public lobby', ok.status === 201 && n < 500, ok)
  const outlaw = await seedPlayer(db, { name: 'Outlaw', ip: nextIp() })
  flag(outlaw)
  const shadow = await api<TownJoinResponse>('POST', '/town/join', { as: outlaw, body: {} })
  check(
    'flagged: a Badlands lobby',
    shadow.status === 201 && shadow.body.lobbyId === 'lobby:500',
    shadow,
  )
  const view = await api<TownDirectoryView>('GET', '/town/lobbies')
  check(
    'the directory never lists the Badlands',
    !view.body.lobbies.some((l) => l.lobbyId === 'lobby:500'),
    view.body,
  )
}

await board()
await sinks()
await blocks()
await badlands()
await frontier()
if (failed() > 0) {
  console.log(`\n${failed()} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)
