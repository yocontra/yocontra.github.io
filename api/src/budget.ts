/** Daily Workers Free admission budget. The existing `month` storage column
 * holds an ISO UTC day; historical monthly rows remain intact and are ignored.
 * Gameplay uses 80% of allowances so settlement/account operations retain headroom.
 */
import type { Env } from './env.ts'

export type Metric = 'lobby_seconds' | 'duel_seconds' | 'ws_messages'

/** Conservative per-mode shares of the daily 10,400 GB-s gameplay allocation. */
export const CEILINGS: Readonly<Record<Metric, number>> = {
  lobby_seconds: 66_560,
  duel_seconds: 16_640,
  // Incoming messages count 20:1: 60,000 requests, reserving 20,000 for other gameplay RPCs.
  ws_messages: 1_200_000,
}

/** Hard cap on concurrent Frontier lobbies (32 players each). */
export const MAX_LOBBIES = 4

const month = (): string => new Date().toISOString().slice(0, 10)

/** Add usage for this UTC day. Callers batch (e.g. a lobby reports once a minute). */
export async function recordUsage(env: Env, metric: Metric, amount: number): Promise<void> {
  if (!(amount > 0)) {
    return
  }
  await env.DB.prepare(
    `INSERT INTO usage (month, metric, amount) VALUES (?, ?, ?)
     ON CONFLICT (month, metric) DO UPDATE SET amount = amount + excluded.amount`,
  )
    .bind(month(), metric, Math.round(amount))
    .run()
}

export interface BudgetState {
  month: string
  usage: Record<Metric, number>
  /** False once any ceiling is reached: refuse new Frontier joins. */
  frontierOpen: boolean
  /** False once the daily admission ceiling is reached: refuse new duels too. */
  duelsOpen: boolean
}

export async function budgetState(env: Env): Promise<BudgetState> {
  const m = month()
  const { results } = await env.DB.prepare('SELECT metric, amount FROM usage WHERE month = ?')
    .bind(m)
    .all<{ metric: Metric; amount: number }>()
  const usage: Record<Metric, number> = { lobby_seconds: 0, duel_seconds: 0, ws_messages: 0 }
  for (const row of results) {
    usage[row.metric] = row.amount
  }
  const over = (factor: number) =>
    (Object.keys(CEILINGS) as Metric[]).some((k) => usage[k] >= CEILINGS[k] * factor)
  return { month: m, usage, frontierOpen: !over(1), duelsOpen: !over(1) }
}
