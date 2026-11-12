import { expect, test as it } from 'bun:test'
import { FEEL } from '../../src/experiments/out-west/data/feel.ts'
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import { STEADY_MS, wait } from '../../src/experiments/out-west/duel/native-combat.ts'
import { advance, resume, retry } from '../../src/experiments/out-west/duel/native-progress.ts'
import { simulate, standoff } from './duel-sim.ts'

const BOSS = OUTLAWS.findIndex((outlaw) => outlaw.gimmick === 'boss')
const COIN = OUTLAWS.findIndex((outlaw) => outlaw.gimmick === 'coin')

function frames(sim: ReturnType<typeof simulate>, seconds: number): void {
  const end = sim.now + seconds * 1000
  while (sim.now < end) {
    sim.frame()
  }
}

it('leaves the cock on its own: the walk for an outlaw, the clock for the boss', () => {
  for (const [level, next] of [
    [0, 'walk'],
    [BOSS, 'wait'],
  ] as const) {
    const sim = simulate({ level, random: 0.5 })
    try {
      sim.d.walked = 0
      sim.d.enter('cock')
      frames(sim, FEEL.inputEnableDelay - 0.05)
      expect(sim.d.phase).toBe('cock')
      frames(sim, 0.1)
      expect(sim.d.phase).toBe(next)
      expect(sim.phases).not.toContain(level === BOSS ? 'walk' : 'wait')
    } finally {
      sim.restore()
    }
  }
})

it('heckles a stalled walk at six seconds and shoots him in the back after twelve', () => {
  const sim = simulate({ level: 0, random: 0.5 })
  try {
    sim.d.walked = 0
    sim.d.enter('walk')
    frames(sim, FEEL.stallHeckle + 0.1)
    expect(sim.d.stallHeckled).toBe(true)
    expect(sim.d.phase).toBe('walk')
    // he turns and fires; the shot lands a third of a second later, as in the original
    frames(sim, FEEL.stallBackShot - FEEL.stallHeckle + 0.4)
    expect(sim.d.phase).toBe('lose')
    expect(sim.d.c.save.run.duels.at(-1)).toEqual({ level: 0, outcome: 'loss', reactionMs: null })
  } finally {
    sim.restore()
  }
})

it('ramps the walk over walkRamp and counts paces from the eased speed', () => {
  const sim = simulate({ level: 0, random: 0.5 })
  try {
    Object.assign(sim.d.c.input, { walking: true })
    sim.d.walked = 0
    sim.d.targetPaces = 99
    sim.d.enter('walk')
    frames(sim, 1)
    // one second at full speed is two paces; easing in costs part of the first walkRamp
    expect(sim.d.walked).toBeGreaterThan(2 - FEEL.walkRamp / FEEL.paceSeconds)
    expect(sim.d.walked).toBeLessThan(2)
    expect(sim.d.stalled).toBe(0)
  } finally {
    sim.restore()
  }
})

it('steps the duel timers at most 50 ms in a long frame', () => {
  const sim = simulate({ level: 0, random: 0.5, frameMs: 120 })
  try {
    sim.d.enter('turn')
    sim.frame()
    expect(sim.d.phaseT).toBeCloseTo(0.05, 6)
  } finally {
    sim.restore()
  }
})

it('starts his draw at the frame start, however long the engine spends before the update', () => {
  const plans = [0, 6].map(
    (updateLag) => standoff({ level: 3, random: 0.4, reaction: 2000, updateLag }).plan,
  )
  expect(plans[1]?.shots).toEqual(plans[0]?.shots ?? [])
})

it('times the reaction from the scheduled bell, not the frame that presents it', () => {
  const result = standoff({ level: 2, random: 0.3, reaction: 211, phase0: 9, updateLag: 4 })
  expect(result.callTime).toBe(result.bell)
  expect(result.ms).toBe(211)
})

it('throws the coin in seven standoffs out of ten', () => {
  for (const [random, fakes] of [
    [0.5, 1],
    [0.8, 0],
  ] as const) {
    const sim = simulate({ level: COIN, random })
    try {
      wait(sim.d)
      while (sim.d.phase === 'wait') {
        sim.frame()
      }
      expect(sim.d.fakes).toBe(fakes)
    } finally {
      sim.restore()
    }
  }
})

it('keeps the boss at phase two after a loss there; a practice back-shot starts him over', () => {
  for (const [ending, again] of [
    ['lose', 'wait'],
    ['coward', 'reload'],
  ] as const) {
    const sim = simulate({ level: BOSS, random: 0.5, bossPhase: 2 })
    try {
      let reloaded = false
      Object.assign(sim.d, {
        startLevel: () => {
          reloaded = true
          return Promise.resolve()
        },
      })
      sim.d.enter(ending)
      retry(sim.d)
      expect(reloaded ? 'reload' : sim.d.phase).toBe(again)
      expect(sim.d.bossPhase).toBe(2)
    } finally {
      sim.restore()
    }
  }
})

it('opens his second standoff 2.4 s after the wound', () => {
  const sim = simulate({ level: BOSS, random: 0.5 })
  try {
    sim.d.enter('bossWound')
    frames(sim, 2.35)
    expect(sim.d.phase).toBe('bossWound')
    frames(sim, 0.1)
    expect(sim.d.phase).toBe('wait')
  } finally {
    sim.restore()
  }
})

it('ends a Legend run after the last outlaw instead of looping', () => {
  const sim = simulate({ level: OUTLAWS.length - 1, random: 0.5, legend: true })
  try {
    let finished = false
    Object.assign(sim.d, {
      finishRun: () => {
        finished = true
      },
    })
    advance(sim.d)
    expect(finished).toBe(true)
    expect(sim.d.interluding).toBe(false)
  } finally {
    sim.restore()
  }
})

it('voids a practice standoff paused at the call: a fresh wait on resume', () => {
  const sim = simulate({ level: 0, random: 0.5 })
  try {
    wait(sim.d)
    while (sim.d.phase !== 'call') {
      sim.frame()
    }
    expect(sim.d.plan).not.toBeNull()
    sim.d.paused = true
    resume(sim.d)
    expect(sim.d.phase as string).toBe('wait')
    expect(sim.d.plan).toBeNull()
  } finally {
    sim.restore()
  }
})

it('holds a press just after a retry as "steady", never a back-shot', () => {
  const sim = simulate({ level: BOSS, random: 0.5, bossPhase: 2 })
  try {
    sim.d.enter('lose')
    retry(sim.d)
    expect(sim.d.phase).toBe('wait')
    sim.press(sim.now + STEADY_MS - 1)
    expect(sim.d.phase).toBe('wait')
    sim.press(sim.now + STEADY_MS + 1)
    expect(sim.d.phase).toBe('coward')
  } finally {
    sim.restore()
  }
})
