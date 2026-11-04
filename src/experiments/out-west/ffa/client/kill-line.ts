/** One kill-feed line: "Killer ✕ Victim", with what made it special, or how a rider died alone. */
import {
  KILL_DEAD_EYE,
  KILL_FARMED,
  KILL_MOST_WANTED,
  KILL_PARDON,
  KILL_SHOWDOWN,
  NONE,
} from '../../contract/town.ts'

export interface KillLine {
  killer: number
  victim: number
  flags: number
}

export function killLine(name: (id: number) => string, ev: KillLine): string {
  const marks: string[] = []
  if (ev.flags & KILL_DEAD_EYE) {
    marks.push('Dead-Eye')
  }
  if (ev.flags & KILL_SHOWDOWN) {
    marks.push('showdown')
  }
  if (ev.flags & KILL_MOST_WANTED) {
    marks.push('Most Wanted')
  }
  if (ev.flags & KILL_PARDON) {
    marks.push('pardoned')
  }
  const tail = marks.length > 0 ? ` · ${marks.join(' · ')}` : ''
  if (ev.killer === NONE || ev.killer === ev.victim) {
    const how = ev.killer === NONE ? 'bit the dust' : 'blew himself up'
    return `${name(ev.victim)} ${how}${tail}`
  }
  return `${name(ev.killer)} ✕ ${name(ev.victim)}${tail}`
}

/**
 * Your kill toast says what the kill paid: the bounty, else the bag the victim dropped for you (it
 * lands just before the kill event), else why it paid nothing. Never a bare "no bounty".
 */
export function killToast(
  flags: number,
  paid: number,
  bags: Iterable<{ mine: boolean; born: number; amount: number }>,
): string {
  if (paid > 0) {
    return `+$${paid} BOUNTY`
  }
  if (flags & KILL_PARDON) {
    return 'SPAWN-PROTECTED: NO REWARD'
  }
  if (flags & KILL_FARMED) {
    return 'SAME RIDER TOO OFTEN: NO REWARD'
  }
  const now = performance.now() / 1000
  let dropped = 0
  for (const b of bags) {
    if (b.mine && now - b.born < 0.5) {
      dropped += b.amount
    }
  }
  return dropped > 0 ? `+$${dropped} DROPPED: GRAB IT` : 'KILL'
}
