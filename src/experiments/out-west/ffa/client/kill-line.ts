/** One kill-feed line: "Killer ✕ Victim", with what made it special, or how a rider died alone. */
import {
  KILL_DEAD_EYE,
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
    marks.push('just spawned, no bounty')
  }
  const tail = marks.length > 0 ? ` · ${marks.join(' · ')}` : ''
  if (ev.killer === NONE || ev.killer === ev.victim) {
    const how = ev.killer === NONE ? 'died' : 'blew himself up'
    return `${name(ev.victim)} ${how}${tail}`
  }
  return `${name(ev.killer)} ✕ ${name(ev.victim)}${tail}`
}
