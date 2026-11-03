/**
 * The spend cap. Cloudflare has no hard spend limit, so the API enforces one: the Workers Paid plan
 * ($5/month) includes 400k GB-s of Durable Object duration and 1M DO requests, and we stay inside
 * that with headroom. Owned by the lead.
 *
 * - Frontier lobbies report occupied seconds; each lobby-second is 0.125 GB-s (128 MB objects).
 * - Incoming WebSocket messages bill at 20:1, so they are counted and divided by 20.
 * When a metric passes its monthly ceiling, new Frontier joins (and, past the hard ceiling, new
 * Bounty Hunt duels) are refused with a friendly "town's full" until the month rolls over.
 */
import type { Env } from './env.ts'

export type Metric = 'lobby_seconds' | 'duel_seconds' | 'ws_messages'

/** Monthly ceilings, chosen to keep total usage inside the $5 plan's included quota. */
export const CEILINGS: Readonly<Record<Metric, number>> = {
  // 2.4M lobby-seconds ≈ 300k GB-s, leaving ~100k GB-s for duels and ranked runs.
  lobby_seconds: 2_400_000,
  duel_seconds: 600_000,
  // 16M incoming messages ≈ 800k billable requests, leaving room for HTTP and DO calls.
  ws_messages: 16_000_000,
}

/** Hard cap on concurrent Frontier lobbies (32 players each). */
export const MAX_LOBBIES = 4

const month = (): string => new Date().toISOString().slice(0, 7)

/** Add usage for this month. Callers batch (e.g. a lobby reports once a minute). */
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
  /** False once usage passes 110% of a ceiling: refuse new duels too. */
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
  return { month: m, usage, frontierOpen: !over(1), duelsOpen: !over(1.1) }
}
