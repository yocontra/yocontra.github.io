import { expect, test as it } from 'bun:test'
import { ShotFeedback } from '../../src/experiments/out-west/client/shot-feedback.ts'

it('confirms delayed own feedback by exact shot identity and never replays its impact', () => {
  const ledger = new ShotFeedback<string>()
  expect(ledger.predict({ id: 1, spawnTick: 20, shots: 0 }, 'first', 0)).toBe(1)
  expect(ledger.predict({ id: 1, spawnTick: 20, shots: 0 }, 'second', 300)).toBe(2)
  expect(ledger.confirm(1, 20, 1, 600)).toEqual({ duplicate: false, predicted: 'first' })
  expect(ledger.confirm(1, 20, 2, 900)).toEqual({ duplicate: false, predicted: 'second' })
  expect(ledger.confirm(1, 20, 2, 950)).toEqual({ duplicate: true, predicted: undefined })
})
it('unconfirmed or expired optimistic feedback cannot hide a later legitimate shot', () => {
  const ledger = new ShotFeedback<string>()
  ledger.predict({ id: 0, spawnTick: 0, shots: 0 }, 'rejected', 0)
  expect(ledger.confirm(0, 0, 1, 6000)).toEqual({ duplicate: false, predicted: undefined })
  expect(ledger.confirm(0, 0, 2, 6100)).toEqual({ duplicate: false, predicted: undefined })
})
it('respawn, reused slots and reconnect or new round namespaces cannot suppress new shots', () => {
  const ledger = new ShotFeedback<string>()
  ledger.confirm(0, 20, 8, 0)
  ledger.predict({ id: 0, spawnTick: 30, shots: 0 }, 'new life', 10)
  expect(ledger.confirm(0, 30, 1, 20)).toEqual({ duplicate: false, predicted: 'new life' })
  expect(ledger.confirm(0, 20, 9, 30).duplicate).toBe(true)
  ledger.clear()
  expect(ledger.confirm(0, 0, 1, 40)).toEqual({ duplicate: false, predicted: undefined })
  ledger.clear()
  ledger.predict({ id: 0, spawnTick: 0, shots: 0 }, 'new round', 50)
  expect(ledger.confirm(0, 0, 1, 60)).toEqual({ duplicate: false, predicted: 'new round' })
})
it('requires the protocol-two authoritative identity instead of guessing from a time window', () => {
  const ledger = new ShotFeedback<string>()
  expect(() => ledger.confirm(0, 0, Number.NaN, 0)).toThrow('Reload')
  expect(() => ledger.confirm(0, -1, 1, 0)).toThrow('Reload')
})
