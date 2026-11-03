/**
 * Call Out: challenge a calm player within 12 m; if they accept within 3 s, both are frozen in a
 * showdown ring (invulnerable to everyone else) for a mini quick-draw. The sim owns the beats and
 * cowardice; the precise draw is judged outside the sim (the lobby runs `judgePvp` on wall-clock
 * timestamps) and fed back through `resolveShowdown`.
 */
import {
  BTN_CALLOUT,
  BTN_FIRE,
  BTN_INTERACT,
  NONE,
  SD_ABORTED,
  SD_COWARD,
  SD_DEAD_HEAT,
  SD_FROZE,
  SD_WIN,
} from '../../contract/town.ts'
import { pressed } from './combat.ts'
import {
  CALLOUT_ACCEPT_TICKS,
  CALLOUT_CALM_TICKS,
  CALLOUT_CONE_DEG,
  CALLOUT_COOLDOWN_TICKS,
  CALLOUT_MIN_CARRY,
  CALLOUT_RANGE,
  SHOWDOWN_FAKE_CUES,
  SHOWDOWN_JUDGE_TICKS,
  SHOWDOWN_MAX_TICKS,
  SHOWDOWN_WAIT_MAX_TICKS,
  SHOWDOWN_WAIT_MIN_TICKS,
} from './constants.ts'
import { cancelChannel, killPlayer } from './death.ts'
import { aimDir } from './move.ts'
import { FFA_XP } from './progression-stub.ts'
import { activePlayers, dist2, type World } from './state.ts'
import type { Player, Showdown } from './types.ts'

/** Cues are at least 350 ms (7 ticks) from each other and from the call. */
const CUE_GAP_TICKS = 7

/** Calm, solvent, free: who may call out or be called out. */
export function canDuel(w: World, p: Player): boolean {
  return (
    p.alive &&
    !p.gone &&
    p.lingerUntil < 0 &&
    p.showdown < 0 &&
    p.carried >= CALLOUT_MIN_CARRY &&
    w.tick - p.lastDamageTick >= CALLOUT_CALM_TICKS
  )
}

/** The eligible player nearest the challenger's aim, within range and the aim cone. */
export function calloutTarget(w: World, p: Player): Player | null {
  const dir = aimDir(p.aim)
  const cosCone = Math.cos((CALLOUT_CONE_DEG * Math.PI) / 180)
  let best: Player | null = null
  let bestD2 = CALLOUT_RANGE ** 2
  for (const q of activePlayers(w)) {
    if (q.id === p.id || !canDuel(w, q)) {
      continue
    }
    const d2 = dist2(p.x, p.z, q.x, q.z)
    if (d2 > bestD2 || d2 === 0) {
      continue
    }
    const d = Math.sqrt(d2)
    if (((q.x - p.x) * dir.x + (q.z - p.z) * dir.z) / d >= cosCone) {
      best = q
      bestD2 = d2
    }
  }
  return best
}

function startShowdown(w: World, a: Player, b: Player): void {
  const start = w.tick
  const callTick = start + w.rng.int(SHOWDOWN_WAIT_MIN_TICKS, SHOWDOWN_WAIT_MAX_TICKS)
  const fakeTicks: number[] = []
  const earliest = start + CUE_GAP_TICKS
  const latest = callTick - CUE_GAP_TICKS
  if (latest > earliest && w.rng.next() < 0.5) {
    fakeTicks.push(w.rng.int(earliest, latest))
  }
  const sd: Showdown = {
    id: w.nextShowdownId,
    a: a.id,
    b: b.id,
    cx: (a.x + b.x) / 2,
    cz: (a.z + b.z) / 2,
    startTick: start,
    callTick,
    fakeTicks,
    phase: 'wait',
  }
  w.nextShowdownId = (w.nextShowdownId % 65_535) + 1
  w.showdowns.set(sd.id, sd)
  for (const p of [a, b]) {
    cancelChannel(w, p)
    p.showdown = sd.id
    p.calledBy = NONE
    p.rollTicks = 0
    p.deadEyeStart = -1
  }
  w.events.push({ type: 'showdown_start', showdown: sd })
}

/**
 * Call-out and accept presses. Returns true if the press was consumed (so INTERACT doesn't also
 * start a bank channel).
 */
export function handleCallout(w: World, p: Player, buttons: number): boolean {
  if (pressed(buttons, p.lastButtons, BTN_INTERACT) && p.calledBy !== NONE) {
    const challenger = w.players[p.calledBy]
    p.calledBy = NONE
    if (challenger && w.tick <= p.calledUntil && canDuel(w, challenger) && canDuel(w, p)) {
      startShowdown(w, challenger, p)
      return true
    }
  }
  if (p.calledBy !== NONE && w.tick > p.calledUntil) {
    p.calledBy = NONE
  }
  if (
    !pressed(buttons, p.lastButtons, BTN_CALLOUT) ||
    w.tick < p.calloutCooldownUntil ||
    !canDuel(w, p) ||
    p.channel
  ) {
    return false
  }
  const target = calloutTarget(w, p)
  if (!target) {
    return false
  }
  target.calledBy = p.id
  target.calledUntil = w.tick + CALLOUT_ACCEPT_TICKS
  p.calloutCooldownUntil = w.tick + CALLOUT_COOLDOWN_TICKS
  w.events.push({ type: 'callout', challenger: p.id, target: target.id })
  return true
}

/** Outcome of the external judge, in sim terms. */
export type ShowdownVerdict =
  | { kind: 'win'; winner: number; winnerMs: number }
  | { kind: 'dead_heat' }
  | { kind: 'froze' }
  | { kind: 'coward'; who: number }
  | { kind: 'aborted' }

function endShowdown(
  w: World,
  sd: Showdown,
  winner: number,
  outcome: number,
  winnerMs: number,
): void {
  sd.phase = 'done'
  w.showdowns.delete(sd.id)
  for (const id of [sd.a, sd.b]) {
    const p = w.players[id]
    if (p && p.showdown === sd.id) {
      p.showdown = -1
    }
  }
  w.events.push({
    type: 'showdown_end',
    id: sd.id,
    winner,
    outcome,
    winnerMs: Math.round(winnerMs),
  })
}

export function resolveShowdown(w: World, id: number, verdict: ShowdownVerdict): void {
  const sd = w.showdowns.get(id)
  if (!sd || sd.phase === 'done') {
    return
  }
  const a = w.players[sd.a]
  const b = w.players[sd.b]
  const other = (pid: number): number => (pid === sd.a ? sd.b : sd.a)
  if (verdict.kind === 'win' || verdict.kind === 'coward') {
    const winnerId = verdict.kind === 'win' ? verdict.winner : other(verdict.who)
    const loser = w.players[other(winnerId)]
    const winner = w.players[winnerId]
    endShowdown(
      w,
      sd,
      winnerId,
      verdict.kind === 'win' ? SD_WIN : SD_COWARD,
      verdict.kind === 'win' ? verdict.winnerMs : 0,
    )
    if (loser?.alive) {
      killPlayer(w, loser, winnerId, { showdown: true, showdownDrop: true })
    }
    if (winner && loser && !loser.bot) {
      winner.stats.xp += FFA_XP.showdownWin
      winner.stats.showdownWins++
    }
    return
  }
  if (verdict.kind === 'dead_heat') {
    endShowdown(w, sd, NONE, SD_DEAD_HEAT, 0)
    for (const p of [a, b]) {
      if (p?.alive) {
        killPlayer(w, p, NONE, { showdown: true })
      }
    }
    return
  }
  endShowdown(w, sd, NONE, verdict.kind === 'froze' ? SD_FROZE : SD_ABORTED, 0)
}

/** Beats, fake-outs, the bell, cowardice by early press, and the 6 s safety cap. */
export function updateShowdowns(w: World, buttonsOf: (id: number) => number): void {
  for (const sd of [...w.showdowns.values()]) {
    const a = w.players[sd.a]
    const b = w.players[sd.b]
    if (!(a && b) || a.gone || b.gone) {
      resolveShowdown(w, sd.id, { kind: 'aborted' })
      continue
    }
    if (sd.phase === 'wait') {
      const early = [a, b].find((p) => pressed(buttonsOf(p.id), p.lastButtons, BTN_FIRE))
      if (early) {
        resolveShowdown(w, sd.id, { kind: 'coward', who: early.id })
        continue
      }
      if (sd.fakeTicks.includes(w.tick)) {
        w.events.push({
          type: 'showdown_fake',
          id: sd.id,
          cue: w.rng.int(0, SHOWDOWN_FAKE_CUES - 1),
        })
      }
      if (w.tick >= sd.callTick) {
        sd.phase = 'called'
        w.events.push({ type: 'showdown_call', id: sd.id })
      }
      continue
    }
    const overdue = w.tick > sd.callTick + SHOWDOWN_JUDGE_TICKS + 2
    if (overdue || w.tick - sd.startTick >= SHOWDOWN_MAX_TICKS) {
      resolveShowdown(w, sd.id, { kind: 'froze' })
    }
  }
}
