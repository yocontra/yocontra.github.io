/**
 * Server-side duel tuning: what the server needs to run a ranked standoff. Values follow the
 * design doc's difficulty table (§3.4–3.5). The server owns these numbers in ranked play, so the
 * client can't speed up the call or slow down the outlaw.
 *
 * The judged numbers (draw, jitter, accuracy, wait, fake chance) are read from the client roster
 * in `data/outlaws.ts`; this file adds only what the server owns: the fake-out cue vocabulary and
 * the boss's clock. Editing a tuning row is a one-file change.
 */
import { FEEL } from '../../src/experiments/out-west/data/feel.ts'
import {
  BOSS_PHASE2,
  BOSS_STRIKE_INTERVAL,
  OUTLAWS,
  RIFLEMAN,
  TOUCH_ALLOWANCE_MS,
} from '../../src/experiments/out-west/data/outlaws.ts'

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
 * The server's fake-out cue vocabulary, one row per outlaw. These names travel to the client,
 * which knows how to play them; the roster's own `fakes` are its private practice set, so the two
 * lists are deliberately not the same.
 */
const CUES: readonly (readonly string[])[] = [
  [],
  [],
  ['crow'],
  ['hiccup', 'bottle'],
  ['coin'],
  COMMON_CUES,
  COMMON_CUES,
  ['gust', ...COMMON_CUES],
  COMMON_CUES,
  ['whistle'],
  ['gang-drr'],
  ['piano-stop'],
  ['lantern', ...COMMON_CUES],
  ['twitch', ...COMMON_CUES],
  ['cards', ...COMMON_CUES],
  ['glint', ...COMMON_CUES],
  ['miscount'],
]

const STRIKES = ['strike:6', 'strike:7', 'strike:8', 'strike:9', 'strike:10', 'strike:11'] as const

/**
 * One row per outlaw, in gauntlet order, derived from the client roster. Outlaws 1–2 are the
 * tutorial pair; 3–15 ramp 405→295 ms and never miss (tuned with tools/duel-sim.ts: a 300 ms
 * player loses about 8 times on a first clear). Two-Gun Delmer (6) is entered at his effective
 * draw: his first shot always misses and the second follows `FEEL.delmerGapMs` later, so the
 * single shot here is 250 + 120.
 */
const TABLE: readonly DuelTuning[] = OUTLAWS.map((outlaw, level) => {
  const own = t(outlaw.draw, outlaw.jitter, outlaw.accuracy)
  let targets: readonly TargetTuning[] = [own]
  if (outlaw.gimmick === 'underboss') {
    targets = [t(RIFLEMAN.draw, RIFLEMAN.jitter, RIFLEMAN.accuracy), own]
  } else if (outlaw.gimmick === 'two-guns') {
    targets = [t(outlaw.draw + FEEL.delmerGapMs, outlaw.jitter, outlaw.accuracy)]
  }
  const row: DuelTuning = {
    // the boss's clock sets his wait, not the table
    waitMs:
      outlaw.gimmick === 'boss'
        ? ([0, 0] as const)
        : ([outlaw.wait[0] * 1000, outlaw.wait[1] * 1000] as const),
    fakeChance: outlaw.fakeChance,
    cues: CUES[level] ?? [],
    targets,
  }
  if (outlaw.gimmick === 'boss') {
    // the roster keeps its clock in seconds; the wire sends ms
    row.sequence = {
      cues: STRIKES,
      intervalMs: [BOSS_STRIKE_INTERVAL[0] * 1000, BOSS_STRIKE_INTERVAL[1] * 1000] as const,
    }
  }
  return row
})

/** The boss's second phase: a bare standoff, no clock. */
const BOSS_PHASE_TWO: DuelTuning = {
  waitMs: [1500, 4000],
  fakeChance: 0.5,
  cues: ['twitch', 'distant-shot'],
  targets: [t(BOSS_PHASE2.draw, BOSS_PHASE2.jitter, 1)],
}

/**
 * Extra ms on every outlaw's draw for a player on a touch screen. One source with the client's
 * `data/outlaws.ts`: a tap reaches the page 35–60 ms after the finger lands, a key about 10 ms.
 * Unposted play only (a guest's Daily): the client can claim `touch`, so ranked runs and posted
 * Daily runs never get it, and the boards stay one ladder.
 */
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

export function tuningFor(level: number, phase: 1 | 2 = 1): DuelTuning | undefined {
  return level === BOSS_LEVEL && phase === 2 ? BOSS_PHASE_TWO : TABLE[level]
}
