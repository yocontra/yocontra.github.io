import { expect, test as it, spyOn } from 'bun:test'
import { Actors } from '../../src/experiments/out-west/client/actors.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'

function rosterFixture() {
  const players = new Map([['7', { hp: 100 }]])
  const incarnations = new Map([['7', { serial: 1 }]])
  const failures = new Map()
  const assignments: DuelActor[] = []
  const owner = Object.assign(Object.create(Actors.prototype) as Actors, {
    appearance: () => undefined,
    game: {},
    players,
    incarnations,
    present: new Set(['7']),
    actors: new Map(),
    pending: new Map(),
    failures,
    notice: { hidden: true },
    lifecycle: new AbortController(),
    assign: (_id: string, actor: DuelActor) => assignments.push(actor),
  })
  const load = Reflect.get(owner, 'ensure') as (this: Actors, id: string) => Promise<void>
  return { load: () => load.call(owner, '7'), players, incarnations, failures, assignments }
}

it('a delayed fallback is discarded when its slot is used by a new rider life', async () => {
  const roster = rosterFixture()
  let resolve: (actor: DuelActor) => void = () => undefined
  const pending = new Promise<DuelActor>((accept) => {
    resolve = accept
  })
  let destroyed = 0
  const fallback = { destroy: () => destroyed++ } as unknown as DuelActor
  const create = spyOn(DuelActor, 'create').mockImplementation(() => pending)
  try {
    const loading = roster.load()
    roster.incarnations.set('7', { serial: 2 })
    resolve(fallback)
    await loading
    expect(destroyed).toBe(1)
    expect(roster.assignments).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)
  } finally {
    create.mockRestore()
  }
})

it('a stale fallback failure does not leave a new rider life waiting for Retry', async () => {
  const roster = rosterFixture()
  let reject: (error: Error) => void = () => undefined
  const pending = new Promise<DuelActor>((_, refuse) => {
    reject = refuse
  })
  const create = spyOn(DuelActor, 'create').mockImplementation(() => pending)
  try {
    const loading = roster.load()
    roster.incarnations.set('7', { serial: 2 })
    reject(new Error('old appearance load failed'))
    await loading
    expect(roster.failures.size).toBe(0)
  } finally {
    create.mockRestore()
  }
})
