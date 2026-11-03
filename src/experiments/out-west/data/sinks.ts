/**
 * The shared money sinks and the monthly Most Wanted board (§4, §5). Pure numbers, shared by the
 * client (prices, copy) and the Worker (enforcement). Owned by stream C.
 */

/** A name change costs $5,000 (§5). */
export const NAME_CHANGE_PRICE = 5000
/** At most one name change per 30 days. */
export const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000
/** A name you gave up is held for you (and nobody else) this long, like a deleted account's. */
export const NAME_HOLD_MS = 30 * 24 * 60 * 60 * 1000

/** "Buy the house a round": $1,000, your name on the saloon chalkboard (§5). */
export const HOUSE_ROUND_PRICE = 1000
/** The chalkboard shows this many most recent rounds. */
export const CHALKBOARD_SIZE = 12

/** The Most Wanted board ranks this many, and the top 10 of a closed month get a dated frame. */
export const MOST_WANTED_WINNERS = 10
export const MOST_WANTED_MAX_LIMIT = 50
/** The reward frame for a top-10 month. The month itself lives on the winners list. */
export const MOST_WANTED_FRAME = 'frame.most-wanted-dated'

/** Reports from this many different licensed players (30 days) mark an account as reported. */
export const REPORTED_AT = 3
/** Reports of cheating from this many different licensed players (30 days) send it to the Badlands. */
export const BADLANDS_REPORTS_AT = 5
export const REPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** A player can block at most this many others. */
export const MAX_BLOCKS = 200

/** UTC month key, `YYYY-MM`. */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

/** The month before `month` (`YYYY-MM`). */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 1))
  return d.toISOString().slice(0, 7)
}

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u
export const isMonth = (value: unknown): value is string =>
  typeof value === 'string' && MONTH.test(value)

/** "November 2026" for `2026-11`. */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** The 1st of next month, UTC, as "December 1": when a spent monthly budget reopens. */
export function reopensOn(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return next.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}
