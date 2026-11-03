/**
 * End-to-end check for the standoff ledger kinds: two signed-in players queue for Bounty Hunt
 * against a running `wrangler dev`, neither fires, and both freeze. Their XP-only entry must be
 * booked as `duel_froze` (the hub's "Standoff: both froze"), never `duel_win`, and read back through
 * `GET /me/ledger`.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8797 --inspector-port 9237
 *   bun api/test/froze-e2e.ts http://localhost:8797 [--expect duel_win]
 *
 * `--expect` names the kind to require instead (e.g. to record what older code booked).
 * Not part of `bun test`. Seeds its own accounts straight into the local D1.
 */
import process from 'node:process'
import { BASE, Client, ORIGIN, waitFor } from './duel-client.ts'
import { check, failed, openLocalD1, seedPlayer } from './local-d1.ts'

const flag = process.argv.indexOf('--expect')
const EXPECT = flag >= 0 ? (process.argv[flag + 1] ?? 'duel_froze') : 'duel_froze'

const db = openLocalD1()
const a = new Client(await seedPlayer(db, { name: 'Statue', ip: '10.71.0.1' }), { reactMs: null })
const b = new Client(await seedPlayer(db, { name: 'Stone', ip: '10.72.0.1' }), { reactMs: null })
const [ua, ub] = await Promise.all([a.queue(), b.queue()])
if (!(ua && ub)) {
  throw new Error('queue failed')
}
a.join(ua)
b.join(ub)
await waitFor(() => a.results.length > 0, 60_000)
const result = a.results[0]
check('both froze', result?.outcome === 'froze', result)
check('XP only on the results sheet', result?.you?.delta === 0 && result.you.xp > 0, result?.you)

const res = await fetch(`${BASE}/me/ledger?limit=5`, {
  headers: { Origin: ORIGIN, Authorization: `Bearer ${a.player.token}` },
})
const { entries } = (await res.json()) as {
  entries: { kind: string; amount: number; xp: number }[]
}
const newest = entries[0]
check(`GET /me/ledger books it as ${EXPECT}`, newest?.kind === EXPECT, entries)
check('with $0 and the XP', newest?.amount === 0 && newest.xp > 0, newest)
process.exit(failed() > 0 ? 1 : 0)
