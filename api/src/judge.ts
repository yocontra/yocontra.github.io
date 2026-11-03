/**
 * Pure adjudication maths for server-authoritative duels. No Worker APIs, so it is unit-testable.
 *
 * The server sends the call at `callSentAt` and sees the shot arrive at `shotSeenAt`. That interval
 * is the player's reaction plus one network round trip, so subtracting the measured RTT recovers the
 * reaction without trusting the client. The client's own measurement is more precise, so it is used
 * when it agrees with what the server observed; a client claiming to be faster than physics allows
 * is clamped to the server's view.
 */

/** Faster than this is anticipation or automation, not a reaction to a bell. */
export const MIN_REACTION_MS = 100
/** Base slack for clock and scheduling noise between client and server. */
export const BASE_TOLERANCE_MS = 30
export const MAX_TOLERANCE_MS = 120

export interface RttStats {
  median: number
  jitter: number
}

export function rttStats(samples: readonly number[]): RttStats {
  if (samples.length === 0) {
    return { median: 0, jitter: MAX_TOLERANCE_MS }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
  const deviations = sorted.map((s) => Math.abs(s - median)).sort((a, b) => a - b)
  const jitter = deviations[Math.floor(deviations.length / 2)] ?? 0
  return { median, jitter }
}

export function tolerance(rtt: RttStats): number {
  return Math.min(MAX_TOLERANCE_MS, BASE_TOLERANCE_MS + 2 * rtt.jitter)
}

/**
 * The reaction time the server will score.
 * @param observedMs time between sending the call and receiving the shot
 * @param localMs the client's own measurement from receiving the call, if any
 */
export function judgedReaction(observedMs: number, localMs: number | null, rtt: RttStats): number {
  const serverView = observedMs - rtt.median
  const floor = serverView - tolerance(rtt)
  if (localMs === null || !Number.isFinite(localMs)) {
    return Math.max(0, serverView)
  }
  return Math.max(localMs, floor)
}

/** Humans are noisy. A run of near-identical reaction times is a bot tell. */
export function looksAutomated(reactions: readonly number[]): boolean {
  if (reactions.length < 5) {
    return false
  }
  const mean = reactions.reduce((sum, r) => sum + r, 0) / reactions.length
  const variance = reactions.reduce((sum, r) => sum + (r - mean) ** 2, 0) / reactions.length
  return Math.sqrt(variance) < 12
}
