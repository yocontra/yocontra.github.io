// biome-ignore-all lint/suspicious/noConsole: a command-line report
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear simulation
/**
 * Difficulty simulator for the out west gauntlet. It plays outlaws 1–17 with simulated humans
 * against the real roster data and the real enemy planner (`duel/judge.ts`), and reports the
 * expected losses per outlaw. Tune `data/roster-*.ts` (and `api/src/tuning.ts` to match) against it.
 *
 *   bun tools/duel-sim.ts [--runs=20000] [--seed=1] [--json]
 *
 * The human model:
 * - Reaction (measured from the bell, as the game measures it): log-normal around the player's
 *   median (σ 0.13), plus a 4% lapse of 100–250 ms.
 * - Profiles: medians of 250, 275, 300, 325 and 350 ms, and a "population" whose medians are drawn
 *   from N(300, 35) clipped to 210–450 ms.
 * - Flinching: each fake-out that fires has a chance to draw you early (a coward, counted as a
 *   loss): 3% for a sound, 6% for the coin, 10% for a twitch or a gunshot, 8% for a miscounted
 *   strike. Players faster than the median flinch a touch more, slower ones less.
 * - The underboss: the first press takes the rifleman, the second follows 100 ms or more later
 *   (a human double tap, about 170 ± 40 ms).
 * - The boss: phase one, then phase two; a loss in phase two retries phase two.
 *
 * "Losses" are failed attempts (shot or coward). The target: a median human (250–350 ms) loses
 * 3–6 times on outlaws 1–15, before the underboss.
 */
import { FEEL } from '../src/experiments/out-west/data/feel.ts'
import {
  BOSS_PHASE2,
  OUTLAWS,
  type Outlaw,
  RIFLEMAN,
} from '../src/experiments/out-west/data/outlaws.ts'
import { planFakes, planShots, type Rng } from '../src/experiments/out-west/duel/judge.ts'

const arg = (k: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
const RUNS = Number(arg('runs') ?? 20_000)
const JSON_OUT = process.argv.includes('--json')

/** Mulberry32: a small seeded RNG, so runs are reproducible. */
function seeded(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const rng = seeded(Number(arg('seed') ?? 1))

function gauss(): number {
  const u = Math.max(1e-12, rng())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

interface Human {
  medianMs: number
}

function reactionMs(h: Human): number {
  let r = h.medianMs * Math.exp(0.13 * gauss())
  if (rng() < 0.04) {
    r += 100 + 150 * rng()
  }
  return r
}

const FLINCH: Readonly<Record<string, number>> = {
  coin: 0.06,
  twitch: 0.1,
  gunshot: 0.1,
  miscount: 0.08,
}

function flinches(h: Human, cue: string): boolean {
  const base = FLINCH[cue] ?? 0.03
  // a quicker hand is a jumpier one
  const k = Math.min(1.6, Math.max(0.6, 300 / h.medianMs))
  return rng() < base * k
}

/** The wait: true when he holds his nerve through every fake-out. */
function survivesWait(h: Human, o: Outlaw, phase2: boolean): boolean {
  const boss = o.gimmick === 'boss'
  const bossClock = boss && !phase2
  const [lo, hi] = phase2 ? [1.5, 4] : o.wait
  const w = (lo + (hi - lo) * rng()) * 1000
  const max = boss || o.gimmick === 'underboss' ? FEEL.maxFakesBoss : FEEL.maxFakes
  const cues = bossClock ? ['miscount'] : o.fakes
  const n = cues.length === 0 ? 0 : planFakes(w, o.fakeChance, max, rng).length
  const fired: string[] = []
  for (let i = 0; i < n; i++) {
    fired.push(cues[Math.floor(rng() * cues.length)] ?? 'crow')
  }
  if (o.gimmick === 'piano') {
    fired.push('piano')
  }
  if (o.gimmick === 'coin' && rng() < 0.7) {
    fired.push('coin')
  }
  return fired.every((c) => !flinches(h, c))
}

/** One attempt after the wait: true when he wins the draw. */
function winsDraw(h: Human, o: Outlaw, phase2: boolean): boolean {
  const under = o.gimmick === 'underboss'
  const plan = planShots(
    0,
    {
      draw: phase2 ? BOSS_PHASE2.draw : o.draw,
      jitter: phase2 ? BOSS_PHASE2.jitter : o.jitter,
      accuracy: o.accuracy,
      assist: 0,
      twoGuns: o.gimmick === 'two-guns',
      rifleman: under ? RIFLEMAN : null,
      secondShotMs: FEEL.secondShotMs,
      delmerGapMs: FEEL.delmerGapMs,
    },
    rng,
  )
  const firstHit = (who: number): number =>
    plan.shots.find((s) => s.who === who && s.hit)?.t ?? Number.POSITIVE_INFINITY
  const r1 = reactionMs(h)
  if (!under) {
    return r1 < firstHit(0) + FEEL.tieMs
  }
  // rifleman first, then Curly
  if (r1 >= firstHit(1) + FEEL.tieMs) {
    return false
  }
  const r2 = r1 + Math.max(FEEL.twoTargetGapMs, 170 + 40 * gauss())
  return r2 < firstHit(0) + FEEL.tieMs
}

/** Failed attempts at one outlaw before he falls (capped, so a wall shows up as a big number). */
function lossesAt(h: Human, o: Outlaw): number {
  let losses = 0
  let phase2 = false
  for (let i = 0; i < 200; i++) {
    if (survivesWait(h, o, phase2) && winsDraw(h, o, phase2)) {
      if (o.gimmick === 'boss' && !phase2) {
        phase2 = true
        continue
      }
      return losses
    }
    losses++
  }
  return losses
}

interface Row {
  profile: string
  perOutlaw: number[]
  firstTry: number[]
  beforeUnderboss: number
  /** Share of players losing 3–6 times before the underboss. */
  inBand: number
  underboss: number
  boss: number
}

function profile(name: string, medianOf: () => number): Row {
  const n = OUTLAWS.length
  const sum = new Array<number>(n).fill(0)
  const first = new Array<number>(n).fill(0)
  let early = 0
  let band = 0
  for (let run = 0; run < RUNS; run++) {
    const h: Human = { medianMs: medianOf() }
    let pre = 0
    OUTLAWS.forEach((o, i) => {
      const l = lossesAt(h, o)
      sum[i] = (sum[i] ?? 0) + l
      if (l === 0) {
        first[i] = (first[i] ?? 0) + 1
      }
      if (i < 15) {
        pre += l
      }
    })
    early += pre
    if (pre >= 3 && pre <= 6) {
      band++
    }
  }
  const per = sum.map((s) => s / RUNS)
  return {
    profile: name,
    perOutlaw: per,
    firstTry: first.map((f) => f / RUNS),
    beforeUnderboss: early / RUNS,
    inBand: band / RUNS,
    underboss: per[15] ?? 0,
    boss: per[16] ?? 0,
  }
}

const rows: Row[] = [250, 275, 300, 325, 350].map((m) => profile(`${m} ms`, () => m))
rows.push(profile('population', () => Math.min(450, Math.max(210, 300 + 35 * gauss()))))

if (JSON_OUT) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const pad = (s: string, w: number): string => s.padStart(w)
  console.log(`out west difficulty sim · ${RUNS} gauntlets per profile\n`)
  console.log('expected losses per outlaw (draw ms · fakeChance)')
  const head = ['#', 'outlaw', 'draw', 'fake', ...rows.map((r) => r.profile)]
  console.log(
    [pad(head[0] ?? '', 2), (head[1] ?? '').padEnd(28), pad('draw', 5), pad('fake', 5)]
      .concat(rows.map((r) => pad(r.profile, 11)))
      .join(' '),
  )
  OUTLAWS.forEach((o, i) => {
    console.log(
      [
        pad(String(i + 1), 2),
        `${o.name} (${o.gimmick})`.slice(0, 28).padEnd(28),
        pad(String(o.draw), 5),
        pad(o.fakeChance.toFixed(2), 5),
      ]
        .concat(
          rows.map((r) =>
            pad(
              `${(r.perOutlaw[i] ?? 0).toFixed(2)} ${Math.round((r.firstTry[i] ?? 0) * 100)}%`,
              11,
            ),
          ),
        )
        .join(' '),
    )
  })
  console.log('\n(each cell: expected failed attempts · chance of a first-try clear)\n')
  for (const r of rows) {
    console.log(
      `${r.profile.padEnd(11)} before the underboss ${r.beforeUnderboss.toFixed(2)} losses` +
        ` (${Math.round(r.inBand * 100)}% in 3–6) · underboss ${r.underboss.toFixed(2)}` +
        ` · boss ${r.boss.toFixed(2)}`,
    )
  }
}
