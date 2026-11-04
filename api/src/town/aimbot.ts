/** The Lobby's aimbot heuristics (spec §3.7): flag an account for review, never auto-ban. */

const AIMBOT_MIN_SHOTS = 50
const AIMBOT_HIT_RATE = 0.85
const AIMBOT_SNAPS = 5

/** A human whose shooting looks automated: over 85% hits across 50+ shots, or repeated snaps. */
export function looksLikeAimbot(st: { shots: number; hits: number; snapHits: number }): boolean {
  return (
    st.shots >= AIMBOT_MIN_SHOTS &&
    (st.hits / st.shots > AIMBOT_HIT_RATE || st.snapHits >= AIMBOT_SNAPS)
  )
}
