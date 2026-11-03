/**
 * The lobby directory's rules, pure (the LobbyDirectory DO persists and serves them):
 * - fill the fullest open lobby below 28; else open the next lobby; only when `MAX_LOBBIES` are
 *   running, use slots 29–32 (otherwise kept for rejoins and late fills);
 * - `lobby:0` always exists and is never drained;
 * - a lobby with ≤4 players is drained (no new joins) while another lobby has room for them;
 * - players are never moved; a leaver's slot is reserved for 60 s for a rejoin;
 * - an empty extra lobby is forgotten after 2 minutes;
 * - at most `MAX_LOBBIES`, and nothing new while the month's budget is spent.
 */
import { MAX_PLAYERS, SOFT_CAP } from '../../../src/experiments/out-west/ffa/sim/constants.ts'

export const HOME_LOBBY = 'lobby:0'
export const RESERVE_MS = 60_000
export const GC_EMPTY_MS = 120_000
export const DRAIN_AT = 4
/** A join the lobby hasn't confirmed yet holds its slot this long. */
export const PENDING_MS = 30_000

export interface LobbyEntry {
  id: string
  /** Humans the lobby last reported. */
  count: number
  state: 'open' | 'draining'
  lastBeat: number
  emptySince: number
  /** Accounts holding a slot: assigned-but-not-arrived, or recently left. accountId → expiry. */
  reserved: Record<string, number>
}

export interface RegistryState {
  lobbies: Record<string, LobbyEntry>
  nextIndex: number
}

export type Assignment =
  | { ok: true; lobbyId: string; players: number }
  | { ok: false; reason: 'over_budget' | 'all_full' }

export function emptyRegistry(now: number): RegistryState {
  return { lobbies: { [HOME_LOBBY]: newEntry(HOME_LOBBY, now) }, nextIndex: 1 }
}

function newEntry(id: string, now: number): LobbyEntry {
  return { id, count: 0, state: 'open', lastBeat: now, emptySince: now, reserved: {} }
}

function prune(e: LobbyEntry, now: number): void {
  for (const [acct, until] of Object.entries(e.reserved)) {
    if (until <= now) {
      delete e.reserved[acct]
    }
  }
}

/** Humans plus held slots. */
export const occupancy = (e: LobbyEntry): number => e.count + Object.keys(e.reserved).length

function reserve(e: LobbyEntry, accountId: string, now: number, ms: number): void {
  e.reserved[accountId] = now + ms
}

export interface AssignOptions {
  accountId: string
  now: number
  /** A specific lobby asked for ("ride to a busier town", or a rejoin link). */
  preferred?: string | undefined
  budgetOpen: boolean
  maxLobbies: number
}

function heldFor(reg: RegistryState, accountId: string): LobbyEntry | undefined {
  return Object.values(reg.lobbies).find((e) => accountId in e.reserved)
}

function pick(reg: RegistryState, opts: AssignOptions): LobbyEntry | undefined {
  const open = Object.values(reg.lobbies)
    .filter((e) => e.state === 'open')
    .toSorted((a, b) => occupancy(b) - occupancy(a) || a.id.localeCompare(b.id))
  const preferred = opts.preferred ? reg.lobbies[opts.preferred] : undefined
  if (preferred && preferred.state === 'open' && occupancy(preferred) < SOFT_CAP) {
    return preferred
  }
  return open.find((e) => occupancy(e) < SOFT_CAP)
}

function overflow(reg: RegistryState): LobbyEntry | undefined {
  return Object.values(reg.lobbies)
    .filter((e) => occupancy(e) < MAX_PLAYERS)
    .toSorted((a, b) => occupancy(b) - occupancy(a) || a.id.localeCompare(b.id))[0]
}

export function assign(reg: RegistryState, opts: AssignOptions): Assignment {
  const { now, accountId } = opts
  for (const e of Object.values(reg.lobbies)) {
    prune(e, now)
  }
  // A rejoin goes back to the lobby holding your slot, budget or not: your carry may be there.
  const held = heldFor(reg, accountId)
  if (held) {
    reserve(held, accountId, now, PENDING_MS)
    return { ok: true, lobbyId: held.id, players: occupancy(held) }
  }
  if (!opts.budgetOpen) {
    return { ok: false, reason: 'over_budget' }
  }
  let target = pick(reg, opts)
  if (!target && Object.keys(reg.lobbies).length >= opts.maxLobbies) {
    target = overflow(reg)
    if (!target) {
      return { ok: false, reason: 'all_full' }
    }
  }
  if (!target) {
    const id = `lobby:${reg.nextIndex}`
    reg.nextIndex++
    target = newEntry(id, now)
    reg.lobbies[id] = target
  }
  reserve(target, accountId, now, PENDING_MS)
  return { ok: true, lobbyId: target.id, players: occupancy(target) }
}

export interface LobbyReport {
  lobbyId: string
  humans: number
  /** Accounts now present (their pending holds are released). */
  arrived: readonly string[]
  /** Accounts that left (they get the 60 s rejoin hold). */
  departed: readonly string[]
  now: number
}

/** A lobby reports its population; recompute draining. */
export function report(reg: RegistryState, r: LobbyReport): void {
  const e = reg.lobbies[r.lobbyId] ?? newEntry(r.lobbyId, r.now)
  reg.lobbies[r.lobbyId] = e
  e.count = r.humans
  e.lastBeat = r.now
  if (r.humans > 0) {
    e.emptySince = 0
  } else if (e.emptySince === 0) {
    e.emptySince = r.now
  }
  for (const a of r.arrived) {
    delete e.reserved[a]
  }
  for (const a of r.departed) {
    reserve(e, a, r.now, RESERVE_MS)
  }
  updateDraining(reg)
}

function updateDraining(reg: RegistryState): void {
  const all = Object.values(reg.lobbies)
  for (const e of all) {
    if (e.id === HOME_LOBBY) {
      e.state = 'open'
      continue
    }
    const roomElsewhere = all.some(
      (o) => o !== e && o.state === 'open' && SOFT_CAP - occupancy(o) >= occupancy(e),
    )
    e.state = occupancy(e) <= DRAIN_AT && occupancy(e) > 0 && roomElsewhere ? 'draining' : 'open'
  }
}

/** Forget empty extra lobbies after 2 minutes. Returns the ids removed. */
export function collect(reg: RegistryState, now: number): string[] {
  const removed: string[] = []
  for (const e of Object.values(reg.lobbies)) {
    prune(e, now)
    const idle =
      e.count === 0 && occupancy(e) === 0 && e.emptySince > 0 && now - e.emptySince >= GC_EMPTY_MS
    if (e.id !== HOME_LOBBY && idle) {
      delete reg.lobbies[e.id]
      removed.push(e.id)
    }
  }
  if (removed.length > 0) {
    updateDraining(reg)
  }
  return removed
}
