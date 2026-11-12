import { spyOn } from 'bun:test'
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import { LocalDuelClock } from '../../src/experiments/out-west/duel/clock.ts'
import {
  call,
  handlePress,
  playCue,
  resolve,
  shoot,
  wait,
} from '../../src/experiments/out-west/duel/native-combat.ts'
import type { NativeDirector } from '../../src/experiments/out-west/duel/native-director.ts'
import { update } from '../../src/experiments/out-west/duel/native-presentation.ts'
import { load } from '../../src/experiments/out-west/save.ts'

/** Presentation is inert here: every unknown property is a callable, assignable no-op. */
const inert: unknown = new Proxy(() => undefined, {
  get: (_target, key) => {
    if (key === Symbol.toPrimitive) {
      return () => 0
    }
    return key === 'then' || key === Symbol.iterator ? undefined : inert
  },
  apply: () => inert,
  set: () => true,
})

function presentation<T extends object>(real: T): T {
  return new Proxy(real, {
    get: (target, key, receiver) => (key in target ? Reflect.get(target, key, receiver) : inert),
  })
}

export interface SimOptions {
  level: number
  random: number
  bossPhase?: 1 | 2
  touch?: boolean
  assist?: boolean
  legend?: boolean
  frameMs?: number
  /** Offset of the frame grid, ms. */
  phase0?: number
  /** Time the engine's systems spend in a frame before the duel's update runs, ms. */
  updateLag?: number
}

/**
 * A director driven through the production frame (`update`) and input (`handlePress`) paths on a
 * virtual clock: rAF timestamps on a fixed grid, `performance.now()` and `Math.random` pinned.
 */
export function simulate(o: SimOptions) {
  let now = 10_000 + (o.phase0 ?? 0)
  const clockSpy = spyOn(performance, 'now').mockImplementation(() => now)
  const randomSpy = spyOn(Math, 'random').mockReturnValue(o.random)
  const outlaw = OUTLAWS[o.level]
  if (!outlaw) {
    throw new Error(`No outlaw ${o.level}`)
  }
  const data = load()
  data.legend = Boolean(o.legend)
  data.settings.assist = Boolean(o.assist)
  data.attempts[o.level] = 1
  // biome-ignore lint/style/useNamingConvention: PlayCanvas's AppBase field for the rAF timestamp
  const app = { _time: 0 }
  const actor = () => presentation({ muzzle: () => null })
  const underboss = outlaw.gimmick === 'underboss'
  const state = {
    phase: 'wait',
    phaseT: 0,
    level: o.level,
    outlaw,
    ranked: false,
    daily: false,
    remote: null,
    paused: false,
    interluding: false,
    board: { isOpen: false },
    bossPhase: o.bossPhase ?? 1,
    enemyAlive: true,
    riflemanAlive: underboss,
    rifleman: underboss ? actor() : null,
    player: actor(),
    enemy: actor(),
    duel: -1,
    walked: 6,
    targetPaces: 6,
    speed: 0,
    stalled: 0,
    stallHeckled: false,
    walkLines: 1,
    lineFreeAt: 0,
    realTime: 0,
    steadyUntil: 0,
    frameStart: null as number | null,
    callTime: 0,
    bellScheduled: false,
    bellAt: 0,
    plan: null,
    shots: 0,
    fakes: 0,
    reactionMs: null,
    lateMs: null,
    secondChance: false,
    hatShot: false,
    handShot: false,
    dailyModifiers: [],
    exitDuel: null,
    game: presentation({ app: presentation(app) }),
    c: presentation({
      save: data,
      input: presentation({ touch: Boolean(o.touch), walking: false }),
      hud: presentation({ menuOpen: false }),
      audio: presentation({ outputLatencyMs: 0, perfToCtx: (t: number) => t / 1000 }),
    }),
  }
  const d = presentation(state) as unknown as NativeDirector
  const phases: string[] = []
  Object.assign(state, {
    enter: (phase: string) => {
      state.phase = phase
      state.phaseT = 0
      phases.push(phase)
    },
    wait: () => wait(d),
    call: () => call(d),
    cue: (cue: string) => playCue(d, cue),
    shoot: (press: Parameters<typeof shoot>[1]) => shoot(d, press),
    resolve: (outcome: Parameters<typeof resolve>[1], ms: number | null) => resolve(d, outcome, ms),
    advance: () => undefined,
    retry: () => undefined,
  })
  d.clock = new LocalDuelClock({
    cue: (_duel, cue) => d.cue(cue),
    call: (duel) => {
      if (duel === d.duel) {
        d.call()
      }
    },
    verdict: () => undefined,
    dropped: () => undefined,
    reconnecting: () => undefined,
    resumed: () => undefined,
  })
  const frameMs = o.frameMs ?? 1000 / 60
  return {
    d,
    phases,
    get now() {
      return now
    },
    /** The next frame's rAF timestamp; input timestamped before it is dispatched first. */
    get next() {
      return now + frameMs
    },
    /** One rAF: the 'frameupdate' stamp, the engine's systems, then the duel's update. */
    frame(): void {
      now += frameMs
      app._time = now
      state.frameStart = now
      now += o.updateLag ?? 0
      update(d, frameMs / 1000)
      now -= o.updateLag ?? 0
      state.frameStart = null
    },
    /** A fire key whose event carries timestamp `t`. */
    press(t: number): void {
      const at = now
      now = t
      handlePress(d, { action: 'fire', t, source: 'key', x: -1, y: -1 })
      now = at
    },
    /** When the clock will call this standoff (the bell's instant). */
    callAt: () => d.clock.callAt(),
    restore(): void {
      clockSpy.mockRestore()
      randomSpy.mockRestore()
    },
  }
}

/** One standoff: presses `reaction` ms (and `second` ms after that) past the scheduled bell. */
export function standoff(o: SimOptions & { reaction: number; second?: number }) {
  const sim = simulate(o)
  try {
    wait(sim.d)
    const bell = sim.callAt() ?? 0
    const presses = [bell + o.reaction]
    if (o.second !== undefined) {
      presses.push(bell + o.reaction + o.second)
    }
    for (
      let i = 0;
      i < 2000 && !['win', 'lose', 'coward', 'bossWound'].includes(sim.d.phase);
      i++
    ) {
      while (sim.d.phase === 'call' && presses.length > 0 && (presses[0] ?? 0) <= sim.next) {
        sim.press(presses.shift() ?? 0)
      }
      sim.frame()
    }
    const best = sim.d.c.save.best[o.level]
    return {
      outcome: sim.d.phase === 'bossWound' ? 'win' : sim.d.phase,
      ms: sim.d.reactionMs,
      grade: best?.grade ?? null,
      purse: sim.d.c.save.run.total,
      bell,
      callTime: sim.d.callTime,
      plan: sim.d.plan,
    }
  } finally {
    sim.restore()
  }
}

/** The last whole ms after the bell that still wins (binary search; wins are monotone). */
export function lastWinningMs(o: SimOptions & { second?: number }): number | null {
  const wins = (reaction: number) => standoff({ ...o, reaction }).outcome === 'win'
  let lo = 40
  let hi = 2000
  if (!wins(lo)) {
    return null
  }
  if (wins(hi)) {
    return hi
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (wins(mid)) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return lo
}
