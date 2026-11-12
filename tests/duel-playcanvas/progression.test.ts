import { expect, test as it } from 'bun:test'
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import { arenaForSlot } from '../../src/experiments/out-west/duel/native-arenas.ts'
import { resolve } from '../../src/experiments/out-west/duel/native-combat.ts'
import type { NativeDirector } from '../../src/experiments/out-west/duel/native-director.ts'
import { dailyDuel, leaveSpecial } from '../../src/experiments/out-west/duel/native-progress.ts'
import { onDuelReport } from '../../src/experiments/out-west/meta/events.ts'
import type { RankedSession } from '../../src/experiments/out-west/net/ranked.ts'
import { load } from '../../src/experiments/out-west/save.ts'
import { inertPresentation, quiet } from '../client-playcanvas/duel-presentation.ts'

const noop = (): void => undefined
function fixture(level = 0): NativeDirector {
  const d = {
    phase: 'call',
    level,
    outlaw: OUTLAWS[level],
    bossPhase: 1,
    enemyAlive: true,
    daily: false,
    ranked: false,
    remote: null,
    shots: 1,
    fakes: 2,
    hatShot: false,
    reactionMs: 200,
    specialSave: null,
    exitDuel: null,
    dailyModifiers: [],
    dailyVerdict: null,
    events: {},
    clock: { cancel: noop, dispose: noop },
    arenas: quiet({ dailyFog: noop }),
    game: { app: { scene: { exposure: 1 } } },
    c: {
      save: load(),
      input: { touch: false },
      audio: quiet({ heartbeat: noop }),
      hud: quiet({
        showCard: noop,
        cardPayout: noop,
        setPurse: noop,
        setMode: noop,
        setDaily: noop,
        hideCard: noop,
        show: noop,
      }),
    },
    hubShot: noop,
    ...inertPresentation(),
  } as unknown as NativeDirector
  d.c.save.attempts[level] = 1
  d.leaveSpecial = () => leaveSpecial(d)
  d.enter = (phase) => {
    d.phase = phase
  }
  d.startLevel = (index) => {
    d.c.save.level = index
    d.c.save.attempts[index] = (d.c.save.attempts[index] ?? 0) + 1
    return Promise.resolve()
  }
  return d
}

it('boss phase one never books a clear; phase two restores a live opponent and books once', () => {
  const d = fixture(16)
  const reports: number[] = []
  const unsubscribe = onDuelReport((report) => reports.push(report.level))
  try {
    d.enemyAlive = false
    resolve(d, 'win', 200)
    expect(d.phase).toBe('bossWound')
    expect(d.enemyAlive).toBe(true)
    expect(d.bossPhase).toBe(2)
    expect(d.c.save.run.duels).toHaveLength(0)
    expect(reports).toHaveLength(0)
    d.enter('call')
    resolve(d, 'win', 200)
    resolve(d, 'win', 200)
    expect(d.c.save.run.duels).toHaveLength(1)
    expect(d.c.save.run.total).toBeGreaterThan(0)
    expect(reports).toEqual([16])
  } finally {
    unsubscribe()
  }
})

it('Daily fog and progression live in a scratch save and restore the gauntlet on exit', async () => {
  const d = fixture(4)
  const saved = d.c.save
  saved.run.total = 500
  saved.level = 4
  let exits = 0
  const fogModes: boolean[] = []
  d.arenas.dailyFog = (enabled) => {
    fogModes.push(enabled)
  }
  const session = { listen: noop, close: noop } as unknown as RankedSession
  await dailyDuel(d, { outlaw: 0, modifiers: ['fog', 'no-bell'] }, session, () => {
    exits++
  })
  expect(d.c.save).not.toBe(saved)
  expect(saved.level).toBe(4)
  expect(saved.run.total).toBe(500)
  expect(fogModes).toEqual([true])
  leaveSpecial(d)
  expect(d.c.save).toBe(saved)
  expect(fogModes).toEqual([true, false])
  expect(exits).toBe(1)
  leaveSpecial(d)
  expect(exits).toBe(1)
})

it('all seventeen campaign slots retain their authored act scenery', () => {
  expect(Array.from({ length: 17 }, (_, slot) => arenaForSlot(slot))).toEqual([
    'street',
    'street',
    'street',
    'street',
    'street',
    'street',
    'depot',
    'depot',
    'depot',
    'depot',
    'mission',
    'mission',
    'mission',
    'bank',
    'bank',
    'street',
    'street',
  ])
})
