import { expect, test as it } from 'bun:test'
import { GraphNode, Vec3 } from 'playcanvas'
import { DynamiteFlight } from '../../src/experiments/out-west/client/dynamite-flight.ts'

function fixture() {
  const hand = new GraphNode('WristR')
  hand.setPosition(2, 1.5, 3)
  const target = new Vec3(8, 0.05, 3)
  let active = true
  const flight = new DynamiteFlight({
    by: 1,
    target,
    started: 1000,
    hand: () => (active ? hand : null),
    origin: new Vec3(2, 1, 3),
  })
  return {
    hand,
    target,
    flight,
    cancel: () => {
      active = false
    },
  }
}
it('the visible stick follows the hand until release, then lands at the server endpoint', () => {
  const { hand, target, flight } = fixture()
  expect(flight.sample(1000).held).toBe(true)
  expect(flight.position.equals(hand.getPosition())).toBe(true)
  hand.setPosition(2.1, 1.8, 3.2)
  expect(flight.sample(1190).held).toBe(true)
  expect(flight.position.equals(hand.getPosition())).toBe(true)
  expect(flight.sample(1200).held).toBe(false)
  const released = flight.position.clone()
  hand.setPosition(100, 100, 100)
  expect(flight.sample(1450).progress).toBeCloseTo(0.5)
  expect(flight.position.x).toBeCloseTo((released.x + target.x) / 2)
  expect(flight.position.y).toBeGreaterThan((released.y + target.y) / 2)
  expect(flight.sample(1700).done).toBe(true)
  expect(flight.position.equals(target)).toBe(true)
})
it('an interrupted or dead hand cannot drag the accepted explosive to a respawn', () => {
  const { hand, flight, cancel, target } = fixture()
  flight.sample(1100)
  const last = flight.position.clone()
  cancel()
  hand.setPosition(500, 10, 500)
  flight.sample(1200)
  expect(flight.position.equals(last)).toBe(true)
  flight.sample(1700)
  expect(flight.position.equals(target)).toBe(true)
})
it('a stalled frame completes the visual without moving its immutable authoritative target', () => {
  const { flight, target } = fixture()
  target.set(100, 100, 100)
  expect(flight.sample(6000).done).toBe(true)
  expect(flight.position.toArray()).toEqual([8, 0.05, 3])
})
