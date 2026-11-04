/**
 * The meta-game on the device (meta-game stream): listens to the duel's reports, keeps the
 * device's medals and challenges (the guest purse), unlocks achievements, and talks to the
 * account: the once-only guest migration on sign-in, hat-shot claims after a ranked win, Legend
 * cosmetics. The account's own medals are booked by the ranked server, never from here.
 */
import type { ProgressResponse } from '../contract/meta.ts'
import { type Achievement, type AchievementState, newlyEarned } from '../data/achievements.ts'
import { dayKey } from '../data/daily.ts'
import {
  CHALLENGE_PAY,
  type Challenge,
  CLAIM_PAY,
  challengeFor,
  emptyMark,
  GUEST_CAP,
  guestCredit,
  isClaim,
  MEDAL_PAY,
  meets,
  mergeMark,
  OUTLAW_COUNT,
  type OutlawMark,
  type TierRank,
  tierFor,
  tierName,
} from '../data/medals.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import { currentPlayer, onAuthChange } from '../net/auth.ts'
import { claimChallenge, claimLegend, fetchProgress, migrateGuest } from '../net/meta.ts'
import { loadMeta, type MetaSave, type SaveData, saveMeta } from '../save.ts'
import { type DuelReport, onDuelReport } from './events.ts'

/** A line for the toast stack. */
export interface Toast {
  kind: 'medal' | 'challenge' | 'achievement' | 'purse' | 'daily'
  kicker: string
  title: string
  line: string
  tier?: TierRank
}

export interface MetaDeps {
  /** The run save (cowardice and attempts this run). */
  save: () => SaveData
  /** The ranked run's id when the current run is ranked. */
  runId: () => string | null
  toast: (t: Toast) => void
}

/** Wait this long after a ranked win before claiming its hat (the credit job books the win first). */
const CLAIM_DELAY_MS = 2500
const CLAIM_TRIES = 4
/** Legend items start at six outlaws beaten. */
const LEGEND_CLAIM_AT = 6
const BOSS = OUTLAW_COUNT - 1

type Where = 'ledger' | 'practice' | 'guest'

const WHERE: Readonly<Record<Where, string>> = {
  ledger: 'Added to your account.',
  practice: 'Practice only. Win it on a ranked run to get paid.',
  guest: 'Saved to your guest purse.',
}

const shortName = (level: number): string => OUTLAWS[level]?.name ?? `Outlaw ${level + 1}`

export class Meta {
  readonly data: MetaSave
  /** The account's server-recorded progress (null signed out, or before it loads). */
  account = null as ProgressResponse | null
  private readonly deps: MetaDeps
  private readonly changed = new Set<() => void>()
  /** Outlaws you drew early on in the current run (Hardin's challenge needs a clean kill). */
  private readonly drewEarly = new Set<number>()
  private syncing = null as Promise<void> | null

  constructor(deps: MetaDeps) {
    this.deps = deps
    this.data = loadMeta()
    onDuelReport((r) => this.later(r))
    // a report still queued when the page goes away is booked then
    globalThis.addEventListener?.('pagehide', () => this.flush())
    onAuthChange(() => {
      this.sync().catch(() => undefined)
    })
  }

  /** Listen for any change (the map and the hub repaint). Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.changed.add(fn)
    return () => {
      this.changed.delete(fn)
    }
  }

  private commit(): void {
    saveMeta(this.data)
    for (const fn of this.changed) {
      fn()
    }
  }

  // ─── what the map shows ──────────────────────────────────────────────────────────────────────

  /** Per outlaw: the better of this device's mark and the account's. */
  marks(): OutlawMark[] {
    return Array.from({ length: OUTLAW_COUNT }, (_, i) =>
      mergeMark(this.data.marks[i], this.account?.marks[i]),
    )
  }

  /** The device's guest purse (uncapped), and what would migrate (capped). */
  guestPurse(): { xp: number; cash: number; migrates: { xp: number; cash: number } } {
    const c = guestCredit({ marks: this.data.marks, clears: this.data.clears })
    return { ...c.raw, migrates: { xp: c.xp, cash: c.cash } }
  }

  achievementState(): AchievementState {
    const s = this.data.stats
    return {
      marks: this.marks(),
      clears: this.data.clears,
      legendBest: this.data.legendBest,
      wins: s.wins,
      hats: s.hats,
      fakesBeaten: s.fakesBeaten,
      dailyDays: Math.max(s.dailyDays.length, this.account?.dailyWins ?? 0),
      gazette: s.gazette.length,
      epilogue: s.epilogue,
      signedIn: s.signedIn,
      moments: new Set(s.moments),
    }
  }

  // ─── the duel's reports ──────────────────────────────────────────────────────────────────────

  private moment(m: string): void {
    if (!this.data.stats.moments.includes(m)) {
      this.data.stats.moments.push(m)
    }
  }

  /** Reports waiting for idle time, in order. */
  private readonly pending: DuelReport[] = []

  /**
   * Book a duel's report in idle time, not on the frame of the shot that ended it (the stats,
   * marks, achievements and the save were 2 ms of the winning frame at the floor proxy). Order is
   * kept, so a drawn-early report still lands before the win that reads it.
   */
  private later(r: DuelReport): void {
    this.pending.push(r)
    if (this.pending.length > 1) {
      return
    }
    const run = (): void => this.flush()
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 1200 })
    } else {
      setTimeout(run, 400)
    }
  }

  private flush(): void {
    for (const r of this.pending.splice(0)) {
      this.onReport(r)
    }
  }

  private onReport(r: DuelReport): void {
    if (r.outcome === 'coward') {
      this.drewEarly.add(r.level)
    }
    if (r.outcome !== 'win') {
      return
    }
    const s = this.data.stats
    s.wins++
    if (r.fakesSeen > 0) {
      s.fakesBeaten++
    }
    if (r.reactionMs !== null && r.reactionMs > 0 && r.reactionMs < 180) {
      this.moment('lightning')
    }
    if (r.daily) {
      const day = dayKey()
      if (!s.dailyDays.includes(day)) {
        s.dailyDays.push(day)
      }
      this.finish()
      return
    }
    if (r.legend) {
      this.data.legendBest = Math.max(this.data.legendBest, r.level + 1)
      this.claimLegend()
      this.finish()
      return
    }
    this.onGauntletWin(r)
    this.finish()
  }

  private onGauntletWin(r: DuelReport): void {
    const save = this.deps.save()
    const level = r.level
    if (level < 0 || level >= OUTLAW_COUNT) {
      return
    }
    this.data.clears |= 1 << level
    this.gauntletMoments(r, save)
    const clean = !this.drewEarly.has(level)
    this.drewEarly.delete(level)
    const prev = this.data.marks[level] ?? emptyMark()
    const tier = tierFor(level, r.reactionMs)
    const c = challengeFor(level)
    const met =
      c !== undefined &&
      meets(c, {
        reactionMs: r.reactionMs,
        fakesSeen: r.fakesSeen,
        firstTry: r.firstTry,
        clean,
        hatShot: r.hatShot,
      })
    const counted = tier > 0 && r.reactionMs !== null ? Math.round(r.reactionMs) : null
    this.data.marks[level] = {
      tier: Math.max(prev.tier, tier) as TierRank,
      bestMs:
        counted === null ? prev.bestMs : Math.min(prev.bestMs ?? Number.POSITIVE_INFINITY, counted),
      challenge: prev.challenge || met,
    }
    this.announce(r, { prev, tier, met, challenge: c })
  }

  /** The toasts for a gauntlet win, and the hat claim on a ranked run. */
  private announce(
    r: DuelReport,
    w: { prev: OutlawMark; tier: TierRank; met: boolean; challenge: Challenge | undefined },
  ): void {
    const account = this.account?.marks[r.level]
    const signedIn = currentPlayer() !== null
    const paysAccount = r.ranked && signedIn
    let where: Where = 'guest'
    if (paysAccount) {
      where = 'ledger'
    } else if (signedIn) {
      where = 'practice'
    }
    if (w.tier > Math.max(w.prev.tier, paysAccount ? (account?.tier ?? 0) : 0)) {
      this.medalToast(r.level, w.tier, r.reactionMs ?? 0, where)
    }
    const c = w.challenge
    if (!(w.met && c)) {
      return
    }
    if (!w.prev.challenge) {
      this.challengeToast(c, where)
    }
    if (isClaim(c) && paysAccount && !account?.challenge) {
      this.claimHat(c, this.deps.runId())
    }
  }

  private gauntletMoments(r: DuelReport, save: SaveData): void {
    if (r.hatShot) {
      this.data.stats.hats++
    }
    if ((save.attempts[r.level] ?? 1) >= 6) {
      this.moment('stubborn')
    }
    if (r.level === BOSS && save.cowardice === 0) {
      this.moment('clean-clear')
    }
  }

  private medalToast(level: number, tier: TierRank, ms: number, where: Where): void {
    const name = tierName(tier) ?? 'bronze'
    const pay = MEDAL_PAY[name]
    this.deps.toast({
      kind: 'medal',
      tier,
      kicker: `${name} medal`,
      title: shortName(level),
      line: `${Math.round(ms)} ms · ${pay.xp} XP + $${pay.cash}. ${WHERE[where]}`,
    })
  }

  private challengeToast(c: Challenge, where: Where): void {
    const pay = isClaim(c) ? CLAIM_PAY : CHALLENGE_PAY
    this.deps.toast({
      kind: 'challenge',
      kicker: 'Challenge complete',
      title: c.title,
      line: `${pay.xp} XP${pay.cash ? ` + $${pay.cash}` : ''}. ${WHERE[where]}`,
    })
  }

  /** A hat shot on a ranked run: claim it once the server has booked the win. */
  private claimHat(c: Challenge, runId: string | null): void {
    if (!runId) {
      return
    }
    const attempt = async (n: number): Promise<void> => {
      const r = await claimChallenge(c.id, runId)
      if (r.ok || r.status === 409) {
        await this.sync()
        return
      }
      if (r.status === 403 && n + 1 < CLAIM_TRIES) {
        // the credit job may not have booked the win yet
        setTimeout(
          () => {
            attempt(n + 1).catch(() => undefined)
          },
          CLAIM_DELAY_MS * (n + 1),
        )
      }
    }
    setTimeout(() => {
      attempt(0).catch(() => undefined)
    }, CLAIM_DELAY_MS)
  }

  private claimLegend(): void {
    if (currentPlayer() && this.data.legendBest >= LEGEND_CLAIM_AT) {
      claimLegend(this.data.legendBest)
        .then((r) => {
          if (r.ok) {
            this.account = r.value
            this.commit()
          }
        })
        .catch(() => undefined)
    }
  }

  /** Persist, announce new achievements, repaint. */
  private finish(): void {
    for (const a of newlyEarned(this.achievementState(), this.data.achievements)) {
      this.unlock(a)
    }
    this.commit()
  }

  private unlock(a: Achievement): void {
    this.data.achievements[a.id] = Date.now()
    this.deps.toast({ kind: 'achievement', kicker: 'Achievement', title: a.title, line: a.line })
  }

  /** A Gazette page was read (the epilogue is slot 17). */
  readGazette(slot: number): void {
    const s = this.data.stats
    if (slot >= OUTLAW_COUNT) {
      s.epilogue = true
    } else if (!s.gazette.includes(slot)) {
      s.gazette.push(slot)
    }
    this.finish()
  }

  hasRead(slot: number): boolean {
    return slot >= OUTLAW_COUNT ? this.data.stats.epilogue : this.data.stats.gazette.includes(slot)
  }

  // ─── the account ─────────────────────────────────────────────────────────────────────────────

  /** Load the account's progress, and migrate the guest purse into it once. */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async doSync(): Promise<void> {
    const player = currentPlayer()
    if (!player) {
      this.account = null
      this.commit()
      return
    }
    this.data.stats.signedIn = true
    await this.migrate(player.accountId)
    const r = await fetchProgress()
    // an older server has no /progress: the device's marks carry on alone
    this.account = r.ok ? r.value : null
    this.claimLegend()
    this.finish()
  }

  private async migrate(accountId: string): Promise<void> {
    if (this.data.migrated.includes(accountId)) {
      return
    }
    const purse = this.guestPurse()
    if (purse.xp === 0 && purse.cash === 0) {
      // nothing to bring: leave the one migration for a device that has something
      return
    }
    const r = await migrateGuest({ marks: this.data.marks, clears: this.data.clears })
    if (r.ok) {
      this.data.migrated.push(accountId)
      this.deps.toast({
        kind: 'purse',
        kicker: 'Guest purse',
        title: 'Guest earnings saved',
        line: `$${r.value.cash} + ${r.value.xp} XP added to your account.${
          r.value.claimed.xp > GUEST_CAP.xp || r.value.claimed.cash > GUEST_CAP.cash
            ? ` Guests can keep up to $${GUEST_CAP.cash} + ${GUEST_CAP.xp} XP.`
            : ''
        }`,
      })
    } else if (r.status === 409) {
      this.data.migrated.push(accountId)
    }
    this.commit()
  }
}

/** For the map's copy: what a challenge pays. */
export const challengePay = (c: Challenge): { xp: number; cash: number } =>
  isClaim(c) ? CLAIM_PAY : CHALLENGE_PAY
