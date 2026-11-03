/**
 * Backgrounding mid-duel (spec §2.3: "App backgrounded: treated as a drop"). Bounty Hunt has no
 * pause, so when the page hides we close the room socket cleanly at once. The room's rules then
 * apply predictably: 5 s of grace before the call (come back in time and the wait re-rolls), none
 * after it (any shot already sent still counts). Coming back reopens the room, which answers with
 * hello and sync: the duel picks up, or the verdict it reached while you were away.
 */
import { RECONNECT_GRACE_MS } from '../contract/duel.ts'
import { onPause, onResume } from '../platform/lifecycle.ts'
import type { Director } from './director.ts'
import type { Phase } from './state.ts'

/** Phases before the call: stepping away here is a drop with grace. */
const BEFORE_CALL: ReadonlySet<Phase> = new Set<Phase>([
  'title',
  'intro',
  'poster',
  'cock',
  'walk',
  'turn',
  'wait',
])

export interface AwayLink {
  suspend: () => void
  resume: () => void
}

/**
 * Watch the page lifecycle for one match. `live()` is true while a verdict is still to come (no
 * result yet, not left). Returns an unsubscribe.
 */
export function watchAway(d: Director, link: AwayLink, live: () => boolean): () => void {
  let away: 'before' | 'after' | null = null
  let since = 0
  const offPause = onPause(() => {
    if (away !== null || !live()) {
      return
    }
    away = BEFORE_CALL.has(d.phase) ? 'before' : 'after'
    since = performance.now()
    link.suspend()
  })
  const offResume = onResume(() => {
    if (away === null) {
      return
    }
    const was = away
    away = null
    const gone = performance.now() - since
    let text = 'After the call there’s no grace: the room judged what it had.'
    if (was === 'before') {
      text =
        gone < RECONNECT_GRACE_MS
          ? 'Back in time: the duel goes on.'
          : `Gone ${Math.round(gone / 1000)} s, past the ${RECONNECT_GRACE_MS / 1000} s grace: that’s a forfeit.`
    }
    d.c.hud.line('You stepped away', text, 4500)
    link.resume()
  })
  return () => {
    offPause()
    offResume()
  }
}
