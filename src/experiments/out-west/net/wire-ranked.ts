/**
 * Ranked gauntlet session wire shapes that aren't in `contract/` yet (the client codes to these;
 * the server side lives in `api/src/routes/ranked.ts` and `api/src/session.ts`). Pure, no DOM.
 *
 *   POST /sessions  { turnstileToken } → 201 RankedSessionCreated
 *                   503 { ok: false, error, reason: 'over_budget' } when the budget meter is spent
 *   GET  /sessions/:id/ws                 the run's socket
 *   GET  /sessions/:id/ws?resume=<token>  the same run after a drop; the server's `hello` then
 *                                         carries `resumed: RankedResume`
 */

export interface RankedSessionCreated {
  wsUrl: string
  /** Lets this client reattach to the run after a drop (null: the server can't resume). */
  resumeToken: string | null
}

/** Where a resumed run stands, from the server. Any standoff in flight was voided unjudged. */
export interface RankedResume {
  /** The outlaw index the server expects the next standoff for. */
  level: number
  /** 1, or 2 for the boss's second draw. */
  phase?: number
  /** The run's purse so far. */
  purse: number
  /** The last duel id the server saw. */
  duel?: number
}

/** The run's socket URL with the resume token. */
export function resumeUrl(wsUrl: string, token: string): string {
  const u = new URL(wsUrl)
  u.searchParams.set('resume', token)
  return u.toString()
}

/** The 1st of next month, UTC, as "December 1". */
export function reopensOn(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return next.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** What ranked says when the month's budget is spent (the server's message wins when it sends one). */
export function rankedClosedCopy(now = new Date()): string {
  return `Ranked runs are closed for the month: the town's spent its keep. They reopen on ${reopensOn(now)} (UTC). Practice is open.`
}
