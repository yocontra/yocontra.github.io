/**
 * Server-side duel tuning: what the server needs to run a ranked standoff. Values follow the
 * design doc's difficulty table (§3.4–3.5). The server owns these numbers in ranked play, so the
 * client can't speed up the call or slow down the outlaw.
 */

export interface TargetTuning {
  /** Enemy draw time after the call, in ms. */
  drawMs: number
  /** Uniform ± jitter on drawMs. */
  jitterMs: number
  /** Chance that this enemy's shot hits. A miss gives the player a little longer. */
  accuracy: number
}

export interface DuelTuning {
  /** Random wait before the call, in ms. */
  waitMs: readonly [number, number]
  /** Chance a fake-out cue fires during the wait. */
  fakeChance: number
  /** Fake-out cue names the client knows how to play. */
  cues: readonly string[]
  /** One entry per enemy that must be shot (the underboss has a rooftop rifleman). */
  targets: readonly TargetTuning[]
  /**
   * Cues played in order at a random interval before the call (the boss's midnight clock).
   * When set, `waitMs` is ignored and the call lands on the final strike.
   */
  sequence?: { cues: readonly string[]; intervalMs: readonly [number, number] }
}

export const LAST_LEVEL = 16
export const BOSS_LEVEL = 16

const t = (drawMs: number, jitterMs: number, accuracy: number): TargetTuning => ({
  drawMs,
  jitterMs,
  accuracy,
})

const COMMON_CUES = ['tumbleweed', 'crow', 'creak', 'dog']

/**
 * One row per outlaw, in gauntlet order (`data/outlaws.ts` ORDER), with the client roster's draw,
 * jitter, accuracy, wait and fake chance. Outlaws 1–2 are the tutorial pair; 3–15 ramp 405→295 ms
 * and never miss (tuned with tools/duel-sim.ts: a 300 ms player loses about 8 times on a first
 * clear). Two-Gun Delmer (6) is entered at his effective draw: his first shot always misses and the
 * second follows 120 ms later, so the single shot here is 250 + 120.
 */
const TABLE: readonly DuelTuning[] = [
  { waitMs: [1000, 2000], fakeChance: 0, cues: [], targets: [t(900, 50, 0.3)] },
  { waitMs: [1000, 2500], fakeChance: 0, cues: [], targets: [t(750, 50, 0.45)] },
  { waitMs: [1200, 2800], fakeChance: 0.4, cues: ['crow'], targets: [t(405, 50, 1)] },
  {
    waitMs: [1000, 3000],
    fakeChance: 0.35,
    cues: ['hiccup', 'bottle'],
    targets: [t(410, 140, 1)],
  },
  { waitMs: [1200, 3000], fakeChance: 0.45, cues: ['coin'], targets: [t(380, 40, 1)] },
  { waitMs: [1500, 4000], fakeChance: 0.45, cues: COMMON_CUES, targets: [t(370, 30, 1)] },
  { waitMs: [800, 1800], fakeChance: 0.5, cues: COMMON_CUES, targets: [t(360, 40, 1)] },
  {
    waitMs: [1500, 3500],
    fakeChance: 0.5,
    cues: ['gust', ...COMMON_CUES],
    targets: [t(350, 30, 1)],
  },
  { waitMs: [1500, 3500], fakeChance: 0.5, cues: COMMON_CUES, targets: [t(338, 15, 1)] },
  { waitMs: [1500, 4000], fakeChance: 0.55, cues: ['whistle'], targets: [t(329, 30, 1)] },
  { waitMs: [1500, 4000], fakeChance: 0.6, cues: ['gang-drr'], targets: [t(321, 30, 1)] },
  { waitMs: [2000, 4500], fakeChance: 0.6, cues: ['piano-stop'], targets: [t(314, 35, 1)] },
  {
    waitMs: [2000, 4500],
    fakeChance: 0.55,
    cues: ['lantern', ...COMMON_CUES],
    targets: [t(307, 35, 1)],
  },
  {
    waitMs: [2000, 5000],
    fakeChance: 0.75,
    cues: ['twitch', ...COMMON_CUES],
    targets: [t(301, 40, 1)],
  },
  {
    waitMs: [2000, 5000],
    fakeChance: 0.6,
    cues: ['cards', ...COMMON_CUES],
    targets: [t(295, 30, 1)],
  },
  {
    waitMs: [2000, 5000],
    fakeChance: 0.45,
    cues: ['glint', ...COMMON_CUES],
    // Rooftop rifleman first, then Curly Bill himself.
    targets: [t(300, 20, 1), t(520, 20, 1)],
  },
  {
    waitMs: [0, 0],
    fakeChance: 0.5,
    cues: ['miscount'],
    targets: [t(312, 35, 1)],
    sequence: {
      cues: ['strike:6', 'strike:7', 'strike:8', 'strike:9', 'strike:10', 'strike:11'],
      intervalMs: [1100, 1600],
    },
  },
]

/** The boss's second phase: a bare standoff, no clock. */
const BOSS_PHASE_TWO: DuelTuning = {
  waitMs: [1500, 4000],
  fakeChance: 0.5,
  cues: ['twitch', 'distant-shot'],
  targets: [t(292, 35, 1)],
}

/**
 * Extra ms on every outlaw's draw for a player on a touch screen (mirrors `TOUCH_ALLOWANCE_MS` in
 * the client's `data/outlaws.ts`). A tap reaches the page 35–60 ms after the finger lands, a key
 * about 10 ms. The reaction is still judged as measured, so medals and boards stay honest.
 */
export const TOUCH_ALLOWANCE_MS = 40

/** `tune` with the touch allowance on every target's draw. */
export function withTouch(tune: DuelTuning): DuelTuning {
  return {
    ...tune,
    targets: tune.targets.map((target) => ({
      ...target,
      drawMs: target.drawMs + TOUCH_ALLOWANCE_MS,
    })),
  }
}

export function tuningFor(level: number, phase: 1 | 2 = 1, touch = false): DuelTuning | undefined {
  const tune = level === BOSS_LEVEL && phase === 2 ? BOSS_PHASE_TWO : TABLE[level]
  return tune && touch ? withTouch(tune) : tune
}
