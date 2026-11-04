/** The Daily Outlaw's server tuning (meta-game stream). Pure, so it is unit-tested. */
import type { DailySpec } from '../../../src/experiments/out-west/data/daily.ts'
import type { DuelTuning } from '../tuning.ts'

/** The server tuning for a day: one target, the spec's draw and the spec's fake-out count. */
export function dailyTuning(spec: DailySpec): DuelTuning {
  return {
    waitMs: spec.waitMs,
    fakeChance: spec.fakes > 0 ? 1 : 0,
    cues: spec.cues,
    targets: [{ drawMs: spec.drawMs, jitterMs: spec.jitterMs, accuracy: spec.accuracy }],
  }
}
