/**
 * A durable outbox for the ranked gauntlet's account credits (first clears, repeat XP, ghost
 * seeding). Owned by stream B.
 *
 * The DuelSession used to send the duel's `result` and then fire the D1 write from
 * `ctx.waitUntil(...)`, logging and dropping any failure. Anything between the verdict and the
 * commit lost the credit for good: a transient D1 error, or the object being reset (a deploy in
 * production, a `wrangler dev` reload locally) while the write was in flight. The player had seen
 * "you won" and was never paid.
 *
 * Now each credit is a job in Durable Object storage, written *before* the result goes out (the
 * output gate holds the socket message until the write is durable, so a result the player sees
 * always has its job on disk). The job is tried at once; on failure it is logged and retried from
 * a storage alarm with backoff, which survives a reset. It leaves the outbox only when its D1
 * batch commits. Retrying is safe because the ledger is idempotent per key, and
 * `gauntletClearStatements` books nothing new for a level this run already first-cleared.
 */

/** What a judged duel owes a signed-in account. Plain data: it is stored as-is. */
export interface CreditJob {
  accountId: string
  /** The ranked run (session id): the gauntlet's repeat-clear key, and the first clear's ref. */
  runId: string
  level: number
  /** A paid gauntlet win (not the boss's first phase). */
  paidWin: boolean
  /** Reward items this duel earned (e.g. the Midnight frame on a clean full clear). */
  grants?: readonly 'frame.midnight'[]
  /** Ghost evidence, from outlaw 6 up. */
  ghost: {
    reactionMs: number | null
    fakesSeen: number
    fakeCoward: boolean
    waitCoward: boolean
    waitedMs: number
  } | null
}

interface Stored {
  job: CreditJob
  attempts: number
  firstAt: number
}

/** The slice of `DurableObjectStorage` the outbox uses (a Map-backed fake in tests). */
export interface OutboxStorage {
  put: (key: string, value: Stored) => Promise<void>
  delete: (key: string) => Promise<boolean>
  list: (options: { prefix: string }) => Promise<Map<string, unknown>>
  getAlarm: () => Promise<number | null>
  setAlarm: (at: number) => Promise<void>
  deleteAlarm: () => Promise<void>
}

export interface OutboxDeps {
  storage: OutboxStorage
  /** Builds and commits the job's D1 batch. Throws on failure. */
  apply: (job: CreditJob) => Promise<void>
  now?: () => number
  log?: (message: string, detail: unknown) => void
}

const PREFIX = 'credit:'
/** First retry after 2 s, doubling to at most 5 minutes. */
const BACKOFF_MS = 2000
const BACKOFF_CAP_MS = 5 * 60_000
/**
 * Set with every new job, so a job whose first attempt never ran (the object was reset right after
 * the verdict) is still picked up. Cleared again when the outbox empties.
 */
export const SAFETY_ALARM_MS = 30_000

export const retryDelay = (attempts: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** Math.max(0, attempts - 1))

const isStored = (v: unknown): v is Stored =>
  typeof v === 'object' && v !== null && 'job' in v && 'attempts' in v

export class CreditOutbox {
  private readonly storage: OutboxStorage
  private readonly apply: (job: CreditJob) => Promise<void>
  private readonly now: () => number
  private readonly log: (message: string, detail: unknown) => void
  /** Keys being applied right now, so a drain and an enqueue never run one job twice at once. */
  private readonly inflight = new Set<string>()

  constructor(deps: OutboxDeps) {
    this.storage = deps.storage
    this.apply = deps.apply
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((message, detail) => console.error(message, detail))
  }

  /**
   * Stores the job durably. Await this before telling the player the outcome; then call `drain()`
   * (it needn't be awaited by the caller's reply).
   */
  async enqueue(key: string, job: CreditJob): Promise<void> {
    const now = this.now()
    await this.storage.put(PREFIX + key, { job, attempts: 0, firstAt: now })
    await this.alarmBy(now + SAFETY_ALARM_MS)
  }

  /** Makes sure an alarm fires no later than `at`. */
  private async alarmBy(at: number): Promise<void> {
    const current = await this.storage.getAlarm()
    if (current === null || current > at) {
      await this.storage.setAlarm(at)
    }
  }

  /** Tries every pending job once. Failures are logged and rescheduled; never thrown. */
  async drain(): Promise<void> {
    const pending = await this.storage.list({ prefix: PREFIX })
    let retryAt: number | null = null
    for (const [key, value] of pending) {
      if (!isStored(value) || this.inflight.has(key)) {
        continue
      }
      this.inflight.add(key)
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one account's credits apply in order
        await this.apply(value.job)
        await this.storage.delete(key)
      } catch (err) {
        const attempts = value.attempts + 1
        this.log('ranked credit failed; will retry', {
          key,
          attempts,
          job: value.job,
          error: err instanceof Error ? err.message : String(err),
        })
        await this.storage.put(key, { ...value, attempts })
        const at = this.now() + retryDelay(attempts)
        retryAt = retryAt === null ? at : Math.min(retryAt, at)
      } finally {
        this.inflight.delete(key)
      }
    }
    if (retryAt !== null) {
      await this.alarmBy(retryAt)
    } else if (this.inflight.size === 0 && (await this.pending()).length === 0) {
      await this.storage.deleteAlarm()
    }
  }

  /** Jobs still owed (for tests and diagnostics). */
  async pending(): Promise<CreditJob[]> {
    const all = await this.storage.list({ prefix: PREFIX })
    return [...all.values()].filter(isStored).map((s) => s.job)
  }
}
