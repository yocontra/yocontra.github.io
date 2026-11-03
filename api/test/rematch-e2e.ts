/**
 * End-to-end check for the rematch window against a running `wrangler dev`: the `rematch` deadline
 * is 20 s after the settled result arrives, and votes cast 15 s after it (a 4 s kill cam plus a slow
 * read of the results sheet) still start the rematch. The room hibernates in the window, so this
 * also exercises its storage alarm.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8797 --inspector-port 9237
 *   bun api/test/rematch-e2e.ts http://localhost:8797
 *
 * Not part of `bun test`. Seeds its own accounts straight into the local D1.
 */
import process from 'node:process'
import { REMATCH_WINDOW_MS } from '../../src/experiments/out-west/contract/duel.ts'
import { Client, waitFor } from './duel-client.ts'
import { check, failed, openLocalD1, seedPlayer } from './local-d1.ts'

const VOTE_AFTER_MS = 15_000

const db = openLocalD1()
const behaviour = { reactMs: 220, rematch: true, rematchDelayMs: VOTE_AFTER_MS }
const a = new Client(await seedPlayer(db, { name: 'Patient', ip: '10.81.0.1' }), behaviour)
const b = new Client(await seedPlayer(db, { name: 'Ponder', ip: '10.82.0.1' }), {
  ...behaviour,
  reactMs: 320,
})
const [ua, ub] = await Promise.all([a.queue(), b.queue()])
if (!(ua && ub)) {
  throw new Error('queue failed')
}
a.join(ua)
b.join(ub)
await waitFor(() => a.results.length > 0, 60_000)
const resultAt = Date.now()
await waitFor(() => a.messages.some((m) => m.type === 'rematch'), 5000)
const votes = a.messages.find((m) => m.type === 'rematch')
const window = votes?.type === 'rematch' ? votes.deadline - resultAt : null
check(
  `the window is about ${REMATCH_WINDOW_MS / 1000} s from the results`,
  window !== null && Math.abs(window - REMATCH_WINDOW_MS) < 1000,
  window,
)
const started = await waitFor(
  () => a.messages.some((m) => m.type === 'hello' && m.rematch === 1),
  VOTE_AFTER_MS + 5000,
)
check(`votes ${VOTE_AFTER_MS / 1000} s after the results still start the rematch`, started)
a.close()
b.close()
process.exit(failed() > 0 ? 1 : 0)
