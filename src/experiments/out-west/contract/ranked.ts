/**
 * The ranked gauntlet protocol (the DuelSession Durable Object): HTTP, socket messages, and resume.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream B.
 *
 * # Flow
 *
 * 1. `POST /sessions` with `{ turnstileToken }` (and optionally `Authorization: Bearer`, so the run
 *    belongs to the account) returns {@link RankedSessionResponse} with HTTP 201.
 *    - 503 `{ ok: false, error, reason: 'over_budget' }` when the month's spend cap is reached
 *      ({@link RankedRefusal}); show `error` and offer practice instead.
 *    - 403 Turnstile or origin, 429 rate limit (with `Retry-After`).
 * 2. Open `wsUrl`. The server sends `hello`, then pings every 400 ms: answer each with `pong`.
 * 3. For each outlaw in order, send `standoff { duel, level }`. The server plays the wait, the
 *    cues and the `call`; send `shot` when the player fires; the server answers `result`.
 *    `duel` numbers must strictly increase within a run (start at 0, or at `resumed.nextDuel`).
 * 4. At the end (or to cash out early), send `finish { name }`; the server answers `final` and
 *    closes the socket.
 *
 * # Resume after a drop or a server restart
 *
 * The run's progress (next outlaw, boss phase, records, purse) lives in the Durable Object's
 * storage, so it survives both a dropped socket and a restart of the object. To continue:
 *
 * - Reconnect to `${wsUrl}?resume=${encodeURIComponent(resumeToken)}` within
 *   {@link RANKED_RESUME_WINDOW_MS} of the drop. Back off 0.25, 0.5, 1, 2, 4 s between tries.
 * - The server sends `hello` with {@link RankedResumed}: the outlaw (`level`, `phase`) to face
 *   next, the run's `purse`, and `nextDuel`, the lowest duel number allowed next. Then send
 *   `standoff { duel: nextDuel, level }` and carry on.
 * - A duel in progress at the drop is **voided** (`resumed.voided` is its number): it is never
 *   judged and never paid, and the same outlaw is faced again under a new duel number. A duel whose
 *   `result` was already sent stays decided (and paid once), even if the client never saw it: the
 *   `purse` and `level` in `resumed` already include it.
 * - A resume from a second tab takes over: the older socket closes with code 4000 (`replaced`).
 * - Refusals come as HTTP status on the upgrade: 403 bad token; 410 the run is over (finished, or
 *   the window passed). On 410, go back to practice and say so.
 * - A signed-in run whose window passes is recorded on the leaderboard as it stood.
 */

/** How long after a drop the run can be resumed (§11.1: resume tickets live 30 s). */
export const RANKED_RESUME_WINDOW_MS = 30_000
/** Ping cadence; answer each `ping` with a `pong`. */
export const RANKED_PING_MS = 400

/** `POST /sessions` 201. */
export interface RankedSessionResponse {
  sessionId: string
  wsUrl: string
  /** Bearer secret for resuming this run. Keep it in memory for the life of the run. */
  resumeToken: string
}

/** `POST /sessions` refusal (503 when over budget). */
export interface RankedRefusal {
  ok: false
  error: string
  reason: 'over_budget'
}

/** Sent in `hello` when the socket resumed an existing run. */
export interface RankedResumed {
  /** The outlaw to face next (0-based). */
  level: number
  /** 2 when the next standoff is the boss's second draw. */
  phase: 1 | 2
  /** The run's purse so far (sum of paid duels). */
  purse: number
  /** The lowest duel number the next `standoff` may use. */
  nextDuel: number
  /** The duel that was in progress at the drop and was voided, or null. */
  voided: number | null
  /** True when every outlaw is beaten: send `finish`. */
  complete: boolean
  /** Duels decided so far (paid or lost). */
  duels: number
}

export type RankedOutcome = 'win' | 'loss' | 'coward'

export type RankedServerMessage =
  | {
      type: 'hello'
      sessionId: string
      economyVersion: number
      /** Present only on a resumed socket. */
      resumed?: RankedResumed
    }
  | { type: 'ping'; n: number }
  | { type: 'cue'; duel: number; cue: string }
  | { type: 'call'; duel: number }
  | {
      type: 'result'
      duel: number
      outcome: RankedOutcome
      reactionMs: number | null
      enemyMs: number | null
      payout: number
      purse: number
      targetsHit: number
    }
  | { type: 'final'; total: number; rank: number }
  | { type: 'error'; message: string; fatal: boolean }

export type RankedClientMessage =
  | { type: 'standoff'; duel: number; level: number }
  /** `localMs`: ms from receiving `call` to the press, or null if pressed before it arrived. */
  | { type: 'shot'; duel: number; target: number; localMs: number | null }
  | { type: 'pong'; n: number }
  /** Ends the run. `name` is used for guests; a signed-in run uses the account name. */
  | { type: 'finish'; name: string }
