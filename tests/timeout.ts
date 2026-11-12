import { availableParallelism, loadavg } from 'node:os'

/**
 * Test timeouts only detect hangs. On a host whose run queue is several times its core count (CI
 * neighbours, parallel agents) honest work stretches with it, so the budget scales by that factor.
 */
export function hangTimeout(milliseconds: number): number {
  const oversubscription = Math.ceil((loadavg()[0] ?? 0) / availableParallelism())
  return milliseconds * Math.min(6, Math.max(1, oversubscription))
}
