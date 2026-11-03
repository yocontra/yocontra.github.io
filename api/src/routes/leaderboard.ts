/** GET /leaderboard: best unflagged gauntlet run per player name. Owned by stream B. */
import { json, type RouteHandler } from '../http.ts'

interface BoardRow {
  name: string
  total: number
  created_at: number
}

export const leaderboardRoutes: RouteHandler = async (request, env, url) => {
  if (url.pathname !== '/leaderboard' || request.method !== 'GET') {
    return null
  }
  const requested = Number(url.searchParams.get('limit') ?? 25)
  const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 25
  const { results } = await env.DB.prepare(
    `SELECT name, total, created_at FROM (
       SELECT name, total, created_at,
              ROW_NUMBER() OVER (PARTITION BY name_key ORDER BY total DESC, created_at ASC) AS rn
       FROM runs WHERE flagged = 0
     )
     WHERE rn = 1
     ORDER BY total DESC, created_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<BoardRow>()
  const entries = results.map((row, i) => ({
    rank: i + 1,
    name: row.name,
    total: row.total,
    createdAt: row.created_at,
  }))
  return json(request, env, { entries }, 200, { 'Cache-Control': 'public, max-age=15' })
}
