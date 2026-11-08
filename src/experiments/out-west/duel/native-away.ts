import { RECONNECT_GRACE_MS } from '../contract/duel.ts'
import { onPause, onResume } from '../platform/lifecycle.ts'
import type { NativeDirector, NativePhase } from './native-director.ts'

const BEFORE_CALL: ReadonlySet<NativePhase> = new Set([
  'title',
  'intro',
  'poster',
  'cock',
  'walk',
  'turn',
  'wait',
])

/** Backgrounding is a real server-observed drop, never a local pause of an authoritative duel. */
export function watchRemoteAway(
  director: NativeDirector,
  link: { suspend: () => void; resume: () => void },
  live: () => boolean,
): () => void {
  let away: { before: boolean; since: number } | null = null
  const offPause = onPause(() => {
    if (away || !live()) {
      return
    }
    away = { before: BEFORE_CALL.has(director.phase), since: performance.now() }
    link.suspend()
  })
  const offResume = onResume(() => {
    if (!away) {
      return
    }
    const { before, since } = away
    away = null
    const elapsed = performance.now() - since
    let text = 'You left after the bell. The duel was judged as it stood.'
    if (before) {
      text =
        elapsed < RECONNECT_GRACE_MS
          ? 'You’re back in time. The duel goes on.'
          : `Away ${Math.round(elapsed / 1000)} s. The limit is ${RECONNECT_GRACE_MS / 1000} s. You forfeit.`
    }
    director.c.hud.line('You stepped away', text, 4500)
    link.resume()
  })
  return () => {
    offPause()
    offResume()
  }
}
