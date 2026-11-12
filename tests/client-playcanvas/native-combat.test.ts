import { expect, test as it, spyOn } from 'bun:test'
import { Vec3 } from 'playcanvas'
import { FEEL } from '../../src/experiments/out-west/data/feel.ts'
import {
  ASSIST_MS,
  BOSS_PHASE2,
  legendDraw,
  OUTLAWS,
  TOUCH_ALLOWANCE_MS,
} from '../../src/experiments/out-west/data/outlaws.ts'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { call, shoot } from '../../src/experiments/out-west/duel/native-combat.ts'
import type { NativeDirector } from '../../src/experiments/out-west/duel/native-director.ts'
import type { Press } from '../../src/experiments/out-west/engine/input.ts'
import { inertPresentation, quiet } from './duel-presentation.ts'

const visuals = await import('../../src/experiments/out-west/client/shot-visuals.ts')
// muzzle flashes and hit sprites need a live PlayCanvas app; the judgement doesn't
spyOn(visuals, 'shotVisuals').mockImplementation(
  () => quiet({}) as unknown as ReturnType<typeof visuals.shotVisuals>,
)

function fixture(level: number, ranked = false) {
  const outlaw = OUTLAWS[level]
  if (!outlaw) {
    throw new Error('Missing test outlaw')
  }
  const shots: { target: number; ms: number | null }[] = []
  const outcomes: string[] = []
  const state = {
    level,
    outlaw,
    ranked,
    remote: null,
    phase: 'wait',
    bossPhase: 1,
    shots: 0,
    reactionMs: null as number | null,
    callTime: 0,
    plan: null,
    player: null,
    enemy: null,
    rifleman: null,
    enemyAlive: true,
    riflemanAlive: outlaw.gimmick === 'underboss',
    dailyModifiers: [],
    clock: {
      callAt: () => null,
      shot: (target: number, ms: number | null) => shots.push({ target, ms }),
    },
    arenas: { toll: () => undefined },
    game: { app: { scene: { exposure: 1 } } },
    c: {
      save: { legend: false, settings: { assist: false } },
      input: { touch: false },
      hud: quiet({ call: () => undefined }),
      audio: quiet({ play: () => undefined, call: () => undefined, heartbeat: () => undefined }),
    },
    ...inertPresentation(),
    enter: (phase: string) => {
      state.phase = phase
    },
    resolve: (outcome: string) => outcomes.push(outcome),
  }
  // Only presentation/audio are absent; tests drive the production call and shot judgement.
  const director = state as unknown as NativeDirector
  return { director, state, shots, outcomes }
}

function press(t: number, source: Press['source'] = 'key'): Press {
  return { action: 'fire', t, source, x: 0, y: 0 }
}

function aimAtCurly(director: NativeDirector): void {
  const actor = (x: number) =>
    ({
      root: { getPosition: () => new Vec3(x, 0, 0) },
      model: { findByName: () => null },
      play: () => undefined,
    }) as unknown as DuelActor
  director.enemy = actor(0)
  director.rifleman = actor(100)
  Object.assign(director, {
    debris: { drop: () => undefined },
    game: {
      camera: { camera: { worldToScreen: (point: Vec3) => point.clone() } },
      app: {
        scene: { exposure: 1 },
        graphicsDevice: {
          canvas: {
            width: 1000,
            height: 1000,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
          },
        },
      },
    },
  })
}

it('preserves the original roster draws, Legend zero jitter and boss phase-two jitter', () => {
  const random = spyOn(Math, 'random').mockReturnValue(0.75)
  try {
    for (let level = 0; level < OUTLAWS.length; level++) {
      const { director, state } = fixture(level)
      state.c.save.settings.assist = true
      state.c.input.touch = true
      call(director)
      expect(director.plan?.e).toBe(
        state.outlaw.draw + state.outlaw.jitter / 2 + ASSIST_MS + TOUCH_ALLOWANCE_MS,
      )
      state.c.save.legend = true
      state.phase = 'wait'
      call(director)
      expect(director.plan?.e).toBe(legendDraw(level) + ASSIST_MS + TOUCH_ALLOWANCE_MS)
    }
    const boss = fixture(OUTLAWS.findIndex((outlaw) => outlaw.gimmick === 'boss'))
    boss.state.bossPhase = 2
    call(boss.director)
    expect(boss.director.plan?.e).toBe(BOSS_PHASE2.draw + BOSS_PHASE2.jitter / 2)
    boss.state.c.save.legend = true
    boss.state.phase = 'wait'
    call(boss.director)
    expect(boss.director.plan?.e).toBe(legendDraw(boss.state.level))
  } finally {
    random.mockRestore()
  }
})

const underboss = OUTLAWS.findIndex((outlaw) => outlaw.gimmick === 'underboss')
for (const source of ['key', 'pointer'] as const) {
  it(`takes the rifleman first with ${source} and requires the original 100 ms second-target gap`, () => {
    const { director, shots, outcomes } = fixture(underboss)
    if (source === 'pointer') {
      aimAtCurly(director)
    }
    director.callTime = 1000
    director.plan = { callT: 1000, e: 1000, shots: [] }
    shoot(director, press(1200, source))
    expect(director.riflemanAlive).toBe(false)
    expect(director.enemyAlive).toBe(true)
    expect(shots).toEqual([{ target: 0, ms: 200 }])
    shoot(director, press(1200 + FEEL.twoTargetGapMs - 1, source))
    expect(director.shots).toBe(1)
    expect(director.enemyAlive).toBe(true)
    expect(outcomes).toEqual([])
    shoot(director, press(1200 + FEEL.twoTargetGapMs, source))
    expect(shots).toEqual([
      { target: 0, ms: 200 },
      { target: 1, ms: 300 },
    ])
    expect(outcomes).toEqual(['win'])
  })

  it(`sends distinct ranked Underboss targets for ${source}, with no third shot`, () => {
    const { director, shots } = fixture(underboss, true)
    if (source === 'pointer') {
      aimAtCurly(director)
    }
    director.callTime = 1000
    for (const t of [1200, 1300, 1400]) {
      shoot(director, press(t, source))
    }
    expect(shots).toEqual([
      { target: 0, ms: 200 },
      { target: 1, ms: 300 },
    ])
    expect(director.shots).toBe(2)
  })
}

it('judges an earlier enemy hit before ignoring an overly quick second Underboss press', () => {
  const { director, shots, outcomes } = fixture(underboss)
  director.callTime = 1000
  director.plan = { callT: 1000, e: 1000, shots: [] }
  shoot(director, press(1200))
  director.plan.shots.push({ t: 1220, who: 0, hit: true, done: false })
  shoot(director, press(1250))
  expect(outcomes).toEqual(['loss'])
  expect(shots).toEqual([{ target: 0, ms: 200 }])
})
