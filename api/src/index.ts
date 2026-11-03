/**
 * out-west API (Cloudflare Worker + D1 + Durable Objects). A thin router: each route module claims
 * the requests it owns. See api/migrations/README.md for ownership of the schema.
 */
import { runLedgerAudit } from './economy/audit.ts'
import type { Env } from './env.ts'
import { corsHeaders, error, type RouteHandler } from './http.ts'
import { accountRoutes } from './routes/account.ts'
import { authRoutes } from './routes/auth.ts'
import { duelRoutes } from './routes/duel.ts'
import { leaderboardRoutes } from './routes/leaderboard.ts'
import { meRoutes } from './routes/me.ts'
import { rankedRoutes } from './routes/ranked.ts'
import { storeRoutes } from './routes/store.ts'
import { townRoutes } from './routes/town.ts'

export { Matchmaker } from './duel/matchmaker.ts'
export { DuelRoom } from './duel/room.ts'
// biome-ignore lint/performance/noBarrelFile: the Workers runtime needs every Durable Object class exported from the entry module
export { DuelSession } from './session.ts'
export { LobbyDirectory } from './town/directory.ts'
export { Lobby } from './town/lobby.ts'

const ROUTES: readonly RouteHandler[] = [
  leaderboardRoutes,
  rankedRoutes,
  authRoutes,
  accountRoutes,
  meRoutes,
  storeRoutes,
  duelRoutes,
  townRoutes,
]

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) })
    }
    const url = new URL(request.url)
    try {
      for (const route of ROUTES) {
        // Routes are tried in order; the first to claim the request wins.
        // biome-ignore lint/performance/noAwaitInLoops: ordered dispatch, at most one route handles a request
        const response = await route(request, env, url, ctx)
        if (response) {
          return response
        }
      }
      return error(request, env, 404, 'Not found.')
    } catch (err) {
      console.error('api error', err)
      return error(request, env, 500, 'Something went wrong.')
    }
  },
  /** Daily: recompute every purse from the ledger and flag mismatches. */
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runLedgerAudit(env).then(() => undefined))
  },
} satisfies ExportedHandler<Env>
