import type { NativeDirector as DuelState } from './native-director.ts'

/**
 * Who talks, and when. Every spoken line in a duel goes through `say`, so the cadence lives in one
 * place:
 *
 * - no two lines from anyone within {@link LINE_GAP} seconds, and never one over another;
 * - nothing from the last pace to the call (the turn, the wait, the boss's clock): the silence is
 *   the tension. A fake-out that *is* a line (the boss's "…TWELVE!") passes `force`, and so do the
 *   town's notices (sudden death, a coward's early shot);
 * - each outlaw opens the walk with at most one line and adds at most one more at a beat (see
 *   `walkLine` in walk.ts); the talker and the counter keep their per-pace habit, thinned to one
 *   line every {@link TALKER_GAP} seconds.
 */

/** No two lines from anyone closer than this, s. */
export const LINE_GAP = 2.5
/** The talker's (and the counter's) own floor between lines, s. */
export const TALKER_GAP = 2.5
/** After a line clears, a breath before the next may start, s. */
const LINE_BREATH = 0.3

const QUIET = new Set(['turn', 'wait', 'bossClock', 'call'])

export interface SayOpts {
  /** How long the caption shows, ms (default 2400). */
  ms?: number
  /** Gap this line needs since the last one, s (default {@link LINE_GAP}). */
  gap?: number
  /** Past the quiet phases and the gap (a fake-out that is a line, a notice). */
  force?: boolean
}

/** True when a line could be said now. */
export function canSay(s: DuelState, gap = LINE_GAP): boolean {
  return !QUIET.has(s.phase) && s.realTime >= s.lineFreeAt + gap - LINE_GAP
}

/** Say one line (caption), if the cadence allows it. Returns true when it was said. */
export function say(s: DuelState, who: string, text: string, o: SayOpts = {}): boolean {
  const ms = o.ms ?? 2400
  if (!(text && (o.force || canSay(s, o.gap)))) {
    return false
  }
  s.c.hud.line(who, text, ms)
  s.c.audio.voiceLine(who, text)
  // the next line waits for this one to clear, and at least the gap
  s.lineFreeAt = s.realTime + Math.max(LINE_GAP, ms / 1000 + LINE_BREATH)
  return true
}
