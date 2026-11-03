/**
 * Pure Bounty Hunt matchmaking rules (§6): widening brackets, the ghost fallback, network and
 * pair rules, and ghost selection. The Matchmaker DO runs `planTick` once a second.
 */
import {
  GHOST_BUTTON_AFTER_MS,
  GHOST_FALLBACK_MS,
} from '../../../src/experiments/out-west/contract/duel.ts'
import type { GhostCandidate } from './ghost.ts'

export interface QueueEntry {
  accountId: string
  joinedAt: number
  /** Dodged players go to the front: they sort as if they joined this much earlier. */
  priority: boolean
  effectiveLevel: number
  rating: number
  /** Hashes of the client's IP and its /24 (IPv4) or /48 (IPv6); null in local dev. */
  net: { ip: string; prefix: string } | null
  /** Too rough a connection for a human duel. */
  ghostsOnly: boolean
  /** Asked for a ghost now (allowed after 8 s). */
  wantsGhost: boolean
  /** Last two queue opponents, most recent first. */
  lastOpponents: readonly string[]
  /** Last ten ghosts faced. */
  recentGhosts: readonly string[]
  /** In the Badlands (§8): paired only with other Badlands players, or with ghosts. */
  badlands?: boolean
  /** Accounts this player blocks or is blocked by: never paired, never served as a ghost. */
  blocked?: readonly string[]
}

/** Either side blocks the other. */
export const blocks = (a: QueueEntry, b: QueueEntry): boolean =>
  (a.blocked ?? []).includes(b.accountId) || (b.blocked ?? []).includes(a.accountId)

export interface Window {
  level: number
  /** ± ms, or null for any rating. */
  rating: number | null
}

export const PRIORITY_HEAD_START_MS = 60_000
export const GHOST_LEVEL_WINDOW = 3
export const GHOST_RATING_WINDOW = 40

export function windowFor(waitedMs: number): Window {
  if (waitedMs < 4000) {
    return { level: 1, rating: 25 }
  }
  if (waitedMs < 8000) {
    return { level: 3, rating: 50 }
  }
  return waitedMs < 12_000 ? { level: 6, rating: null } : { level: 12, rating: null }
}

export const ghostButton = (waitedMs: number): boolean => waitedMs >= GHOST_BUTTON_AFTER_MS

export function sameNetwork(a: QueueEntry['net'], b: QueueEntry['net']): boolean {
  if (!(a && b)) {
    return false
  }
  return a.ip === b.ip || a.prefix === b.prefix
}

/** The same pair can't be matched more than twice in a row from the queue. */
export function thirdInARow(a: QueueEntry, b: QueueEntry): boolean {
  const aTwice =
    a.lastOpponents.length >= 2 && a.lastOpponents.slice(0, 2).every((o) => o === b.accountId)
  const bTwice =
    b.lastOpponents.length >= 2 && b.lastOpponents.slice(0, 2).every((o) => o === a.accountId)
  return aTwice || bTwice
}

const within = (w: Window, a: QueueEntry, b: QueueEntry): boolean =>
  Math.abs(a.effectiveLevel - b.effectiveLevel) <= w.level &&
  (w.rating === null || Math.abs(a.rating - b.rating) <= w.rating)

export const score = (a: QueueEntry, b: QueueEntry): number =>
  Math.abs(a.effectiveLevel - b.effectiveLevel) * 10 + Math.abs(a.rating - b.rating)

export function canPair(a: QueueEntry, b: QueueEntry, now: number): boolean {
  if (a.accountId === b.accountId || a.ghostsOnly || b.ghostsOnly) {
    return false
  }
  if (sameNetwork(a.net, b.net) || thirdInARow(a, b) || blocks(a, b)) {
    return false
  }
  // The Badlands is a shadow pool: its players only ever meet each other.
  if ((a.badlands ?? false) !== (b.badlands ?? false)) {
    return false
  }
  // Both players' windows must allow it: the newer player's tighter window protects them too.
  return within(windowFor(now - a.joinedAt), a, b) && within(windowFor(now - b.joinedAt), a, b)
}

export type TickAction = { kind: 'pair'; a: string; b: string } | { kind: 'ghost'; a: string }

const sortKey = (e: QueueEntry): number => e.joinedAt - (e.priority ? PRIORITY_HEAD_START_MS : 0)

/** One queue tick: oldest first, best-scored candidate, ghosts at 18 s or on request. */
export function planTick(entries: readonly QueueEntry[], now: number): TickAction[] {
  const queue = [...entries].sort((x, y) => sortKey(x) - sortKey(y))
  const taken = new Set<string>()
  const actions: TickAction[] = []
  for (const e of queue) {
    if (taken.has(e.accountId)) {
      continue
    }
    const waited = now - e.joinedAt
    if (e.wantsGhost || waited >= GHOST_FALLBACK_MS) {
      taken.add(e.accountId)
      actions.push({ kind: 'ghost', a: e.accountId })
      continue
    }
    let best: QueueEntry | null = null
    for (const c of queue) {
      if (taken.has(c.accountId) || !canPair(e, c, now)) {
        continue
      }
      if (!best || score(e, c) < score(e, best)) {
        best = c
      }
    }
    if (best) {
      taken.add(e.accountId)
      taken.add(best.accountId)
      actions.push({ kind: 'pair', a: e.accountId, b: best.accountId })
    }
  }
  return actions
}

/**
 * A ghost for `e`: within ±3 effective levels and ±40 ms of rating; not them, not their network,
 * not one of their last ten ghosts, not anyone they block or who blocks them. Null means a Town
 * Outlaw. (Flagged accounts' ghosts are never candidates: `eligibleGhosts` leaves them out.)
 */
export function pickGhost(
  e: QueueEntry,
  ghosts: readonly GhostCandidate[],
  netOf: (accountId: string) => QueueEntry['net'],
  rng: () => number = Math.random,
): GhostCandidate | null {
  const options = ghosts.filter((g) => {
    const level = Math.min(50, g.level + 10 * g.prestige)
    return (
      g.accountId !== e.accountId &&
      !e.recentGhosts.includes(g.accountId) &&
      !(e.blocked ?? []).includes(g.accountId) &&
      !sameNetwork(e.net, netOf(g.accountId)) &&
      Math.abs(level - e.effectiveLevel) <= GHOST_LEVEL_WINDOW &&
      Math.abs(g.drawRating - e.rating) <= GHOST_RATING_WINDOW
    )
  })
  return options[Math.floor(rng() * options.length)] ?? null
}
