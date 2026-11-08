/**
 * Local integration fixture. Never used by the production Wrangler configuration.
 * From the repository root, using the supported Node version:
 * bun x wrangler d1 migrations apply out-west-native-test --local --config api/test/wrangler.native-test.jsonc
 * bun x wrangler dev --local --config api/test/wrangler.native-test.jsonc --port 8792 --inspector-port 9232
 * The tracked browser harnesses use OW_API=http://127.0.0.1:8792 and a client on4390.
 */

import { signAccessToken } from '../src/auth/token.ts'
import { createProfileStatements } from '../src/economy/profile.ts'
import type { Env } from '../src/env.ts'
import worker from '../src/index.ts'
import type { SettlementProbe } from './settlement-worker.ts'

// biome-ignore lint/performance/noBarrelFile: Wrangler requires Durable Object class exports from its entrypoint
export {
  DailySession,
  DuelRoom,
  DuelSession,
  Lobby,
  LobbyDirectory,
  Matchmaker,
} from '../src/index.ts'
export { SettlementProbe } from './settlement-worker.ts'
export default {
  async fetch(
    request: Request,
    env: Env & { SETTLEMENT?: DurableObjectNamespace<SettlementProbe> },
    ctx: ExecutionContext,
  ) {
    const pathname = new URL(request.url).pathname
    if (
      ['/__test/settlement', '/__test/orphan-socket', '/__test/restart-settlement'].includes(
        pathname,
      ) &&
      env.SETTLEMENT
    ) {
      const probe = env.SETTLEMENT.get(env.SETTLEMENT.idFromName('settlement'))
      return probe.fetch(request)
    }
    if (pathname === '/__test/exhaust') {
      const directory = env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName('dir:global'))
      const id = `test-exhaust-${crypto.randomUUID()}`
      await directory.leaseRoom(id, 0)
      await directory.leaseRoom(id, 1_200_000, true)
      return Response.json({ ok: true })
    }
    if (pathname === '/__test/seed') {
      const id = crypto.randomUUID()
      const name = `Rider${id.slice(0, 6)}`
      await env.DB.prepare('INSERT INTO accounts(id,name,name_key,created_at) VALUES(?,?,?,?)')
        .bind(id, name, name.toLowerCase(), Date.now())
        .run()
      await env.DB.batch(createProfileStatements(env, id))
      await env.DB.prepare('UPDATE profiles SET gauntlet_clears=7 WHERE account_id=?')
        .bind(id)
        .run()
      const access = await signAccessToken(env.AUTH_SECRET, {
        accountId: id,
        name,
        sid: crypto.randomUUID(),
        platform: 'web',
        authTime: Date.now(),
      })
      return Response.json({ accountId: id, name, ...access })
    }
    return worker.fetch(request, env, ctx)
  },
}
