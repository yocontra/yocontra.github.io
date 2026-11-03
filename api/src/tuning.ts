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

const TABLE: readonly DuelTuning[] = [
  { waitMs: [1000, 2000], fakeChance: 0, cues: [], targets: [t(900, 50, 0.3)] },
  { waitMs: [1000, 2500], fakeChance: 0, cues: [], targets: [t(820, 60, 0.45)] },
  { waitMs: [1200, 2800], fakeChance: 0.2, cues: ['crow'], targets: [t(750, 60, 0.55)] },
  { waitMs: [1200, 3000], fakeChance: 0.3, cues: ['coin'], targets: [t(690, 50, 0.65)] },
  {
    waitMs: [1000, 3000],
    fakeChance: 0.15,
    cues: ['hiccup', 'bottle'],
    targets: [t(640, 150, 0.4)],
  },
  { waitMs: [800, 1800], fakeChance: 0.2, cues: COMMON_CUES, targets: [t(590, 50, 0.7)] },
  {
    waitMs: [1500, 3500],
    fakeChance: 0.25,
    cues: ['gust', ...COMMON_CUES],
    targets: [t(550, 40, 0.75)],
  },
  { waitMs: [1500, 3500], fakeChance: 0.25, cues: COMMON_CUES, targets: [t(510, 20, 0.8)] },
  { waitMs: [1500, 4000], fakeChance: 0.3, cues: ['whistle'], targets: [t(475, 40, 0.8)] },
  { waitMs: [1500, 4000], fakeChance: 0.25, cues: COMMON_CUES, targets: [t(445, 40, 0.9)] },
  { waitMs: [1500, 4000], fakeChance: 0.4, cues: ['gang-drr'], targets: [t(420, 40, 0.85)] },
  { waitMs: [2000, 4500], fakeChance: 0.4, cues: ['piano-stop'], targets: [t(395, 30, 0.85)] },
  {
    waitMs: [2000, 4500],
    fakeChance: 0.35,
    cues: ['lantern', ...COMMON_CUES],
    targets: [t(375, 30, 0.9)],
  },
  {
    waitMs: [2000, 5000],
    fakeChance: 0.6,
    cues: ['twitch', ...COMMON_CUES],
    targets: [t(355, 30, 0.9)],
  },
  {
    waitMs: [2000, 5000],
    fakeChance: 0.4,
    cues: ['cards', ...COMMON_CUES],
    targets: [t(335, 10, 0.95)],
  },
  {
    waitMs: [2000, 5000],
    fakeChance: 0.45,
    cues: ['glint', ...COMMON_CUES],
    // Rooftop rifleman first, then Curly Bill himself.
    targets: [t(330, 20, 0.95), t(560, 20, 0.95)],
  },
  {
    waitMs: [0, 0],
    fakeChance: 0.5,
    cues: ['miscount'],
    targets: [t(310, 15, 1)],
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
  targets: [t(280, 15, 1)],
}

export function tuningFor(level: number, phase: 1 | 2 = 1): DuelTuning | undefined {
  if (level === BOSS_LEVEL && phase === 2) {
    return BOSS_PHASE_TWO
  }
  return TABLE[level]
}
