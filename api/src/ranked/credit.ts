/**
 * What a judged ranked duel owes a signed-in account, and how it is applied: the gauntlet grant
 * (stream C), reward items (the Midnight frame), and ghost seeding from outlaw 6 up, in one D1
 * batch. The DuelSession stores each job in its outbox before the result goes out.
 */
import type { DuelRecord } from '../../../src/experiments/out-west/data/economy.ts'
import type { CreditJob } from '../duel/credit-outbox.ts'
import { gauntletClearStatements, getProfile, grantItemStatement } from '../duel/external.ts'
import {
  drawRating,
  GHOST_RING,
  type GhostSnapshot,
  ghostRecordStatements,
  RANKED_GHOST_MIN_LEVEL,
} from '../duel/ghost.ts'
import type { WaitStats } from '../duel/standoff.ts'
import type { Env } from '../env.ts'
import { reviewTiming } from '../moderation/timing.ts'
import type { RunState } from './run-state.ts'

/** The credit job for one judged duel of `run` (already updated with this duel's outcome). */
export function creditJobFor(
  run: RunState,
  duel: {
    level: number
    outcome: DuelRecord['outcome']
    reactionMs: number | null
    stats: WaitStats
    bossPhaseOne: boolean
  },
): CreditJob {
  const paidWin = duel.outcome === 'win' && !duel.bossPhaseOne
  // The Midnight frame (§7): the full gauntlet cleared in one run without drawing early.
  const midnight = paidWin && run.complete && !run.coward
  return {
    accountId: run.accountId ?? '',
    runId: run.sessionId,
    level: duel.level,
    paidWin,
    ...(midnight ? { grants: ['frame.midnight'] as const } : {}),
    ghost:
      duel.level >= RANKED_GHOST_MIN_LEVEL
        ? {
            reactionMs: duel.outcome === 'coward' ? null : duel.reactionMs,
            fakesSeen: duel.stats.fakesSeen,
            fakeCoward: duel.stats.coward?.onCue ?? false,
            waitCoward: duel.stats.coward !== null && !duel.stats.coward.onCue,
            waitedMs: duel.stats.waitedMs,
          }
        : null,
  }
}

interface GhostCache {
  snapshot: GhostSnapshot
  recent: number[]
}

export class RankedCredits {
  private readonly env: Env
  private readonly background: (p: Promise<unknown>) => void
  /** The signed-in player's recent reactions and poster, loaded on first need. */
  private ghost: GhostCache | null = null

  constructor(env: Env, background: (p: Promise<unknown>) => void) {
    this.env = env
    this.background = background
  }

  /** Applies one job in one batch. Throws on failure so the outbox retries it. */
  async apply(job: CreditJob): Promise<void> {
    const statements: D1PreparedStatement[] = []
    if (job.paidWin) {
      statements.push(
        ...(await gauntletClearStatements(this.env, job.accountId, job.level, job.runId)),
      )
    }
    for (const item of job.grants ?? []) {
      statements.push(grantItemStatement(this.env, job.accountId, item))
    }
    const ghost = job.ghost ? await this.loadGhost(job.accountId) : null
    let seeded: GhostCache | null = null
    if (job.ghost && ghost) {
      const judged = job.ghost.reactionMs
      const recent = judged === null ? ghost.recent : [...ghost.recent, judged].slice(-GHOST_RING)
      seeded = { recent, snapshot: { ...ghost.snapshot, drawRating: drawRating(recent) } }
      statements.push(
        ...ghostRecordStatements(this.env, {
          accountId: job.accountId,
          source: 'ranked',
          froze: false,
          ...job.ghost,
          snapshot: seeded.snapshot,
        }),
      )
    }
    if (statements.length > 0) {
      await this.env.DB.batch(statements)
    }
    if (seeded) {
      // only once it committed, so a retried job doesn't count the sample twice in memory
      this.ghost = seeded
      // The §8 timing statistics on the reactions this run just added (Badlands on a tell).
      this.background(reviewTiming(this.env, job.accountId, 'ranked'))
    }
  }

  private async loadGhost(accountId: string): Promise<GhostCache | null> {
    if (this.ghost) {
      return this.ghost
    }
    const profile = await getProfile(this.env, accountId)
    if (!profile) {
      return null
    }
    const { results } = await this.env.DB.prepare(
      `SELECT ms FROM ghost_samples WHERE account_id = ? ORDER BY id DESC LIMIT ${GHOST_RING}`,
    )
      .bind(accountId)
      .all<{ ms: number }>()
    const recent = results.map((r) => r.ms).reverse()
    this.ghost = {
      recent,
      snapshot: {
        name: profile.name,
        level: profile.level,
        prestige: profile.prestige,
        loadout: profile.loadout,
        drawRating: drawRating(recent),
      },
    }
    return this.ghost
  }
}
