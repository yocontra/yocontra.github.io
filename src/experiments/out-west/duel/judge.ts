/**
 * Pure duel timing. All times are performance.now() milliseconds; nothing in
 * here touches the DOM, three.js or audio, so it can be driven by an injected
 * clock and RNG.
 */

export interface EnemyShot {
  /** Absolute time the shot goes off. */
  t: number
  hit: boolean
  /** Which shooter (0 = the outlaw, 1 = the rifleman). */
  who: number
  done: boolean
}

export interface DrawPlan {
  callT: number
  shots: EnemyShot[]
  /** Base draw time used (for debug/ledger). */
  e: number
}

export type Rng = () => number

export interface PlanSpec {
  draw: number
  jitter: number
  accuracy: number
  /** Extra ms from assist mode. */
  assist: number
  twoGuns?: boolean
  rifleman?: { draw: number; jitter: number; accuracy: number } | null
  secondShotMs: number
  delmerGapMs: number
}

/** Build the enemy's shots for a call that became visible at callT. */
export function planShots(callT: number, s: PlanSpec, rng: Rng): DrawPlan {
  const jit = (j: number) => (rng() * 2 - 1) * j
  const e = s.draw + jit(s.jitter) + s.assist
  const shots: EnemyShot[] = []
  if (s.twoGuns) {
    // First always misses, second 120 ms later at his accuracy, then a sure third.
    shots.push({ t: callT + e, hit: false, who: 0, done: false })
    const second = rng() < s.accuracy
    shots.push({ t: callT + e + s.delmerGapMs, hit: second, who: 0, done: false })
    if (!second) {
      shots.push({ t: callT + e + s.delmerGapMs + s.secondShotMs, hit: true, who: 0, done: false })
    }
  } else {
    const first = rng() < s.accuracy
    shots.push({ t: callT + e, hit: first, who: 0, done: false })
    if (!first) {
      shots.push({ t: callT + e + s.secondShotMs, hit: true, who: 0, done: false })
    }
  }
  if (s.rifleman) {
    const r = s.rifleman
    const re = r.draw + jit(r.jitter) + s.assist
    const first = rng() < r.accuracy
    shots.push({ t: callT + re, hit: first, who: 1, done: false })
    if (!first) {
      shots.push({ t: callT + re + s.secondShotMs, hit: true, who: 1, done: false })
    }
  }
  shots.sort((a, b) => a.t - b.t)
  return { callT, shots, e }
}

/** Reaction time in ms for a press at event time `t`. */
export function reaction(t: number, callT: number): number {
  return t - callT
}

/**
 * The next enemy shot that should resolve now. A shot only resolves once
 * `now` is past it by the tie window, so a press within 8 ms still wins.
 */
export function dueShot(
  plan: DrawPlan,
  now: number,
  tieMs: number,
  alive: (who: number) => boolean,
): EnemyShot | null {
  for (const s of plan.shots) {
    if (s.done || !alive(s.who)) {
      continue
    }
    if (now >= s.t + tieMs) {
      return s
    }
    return null
  }
  return null
}

/**
 * Any unresolved shot that went off before a press at time t (outside the tie
 * window). Lets a press that arrives late in a hitched frame still be judged
 * on timestamps rather than on which handler ran first.
 */
export function shotsBefore(
  plan: DrawPlan,
  t: number,
  tieMs: number,
  alive: (who: number) => boolean,
): EnemyShot[] {
  return plan.shots.filter((s) => !s.done && alive(s.who) && s.t + tieMs < t)
}

/** Uniform random in [a, b]. */
export function between(rng: Rng, a: number, b: number): number {
  return a + (b - a) * rng()
}

/** Fake-out times inside a wait of W ms (35–80% of W), spaced apart. */
export function planFakes(w: number, chance: number, max: number, rng: Rng): number[] {
  const out: number[] = []
  for (let i = 0; i < max; i++) {
    if (rng() >= chance) {
      continue
    }
    const t = between(rng, 0.35 * w, 0.8 * w)
    if (out.every((o) => Math.abs(o - t) > 450)) {
      out.push(t)
    }
  }
  return out.sort((a, b) => a - b)
}
