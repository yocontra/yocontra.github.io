/** Run the actual Colyseus fixed-step callback with controlled wall time inside workerd. */
import { Room } from '@colyseus/core'
import { FixedRoomClock } from '../src/game/clock.ts'

export async function clockProbe() {
  const room = new Room()
  room.clock.stop()
  const nativeNow = Date.now
  const nativeInterval = globalThis.setInterval
  let wall = nativeNow()
  let callback: (() => void) | undefined
  let steps = 0
  const results: number[] = []
  try {
    Date.now = () => wall
    room.clock = new FixedRoomClock()
    const interceptInterval = (
      handler: (...args: unknown[]) => void,
      _delay?: number,
      ...args: unknown[]
    ) => {
      callback = () => handler(...args)
      return nativeInterval(handler, 3_600_000, ...args)
    }
    Reflect.set(globalThis, 'setInterval', interceptInterval)
    room.setFixedTimestep(
      () => {
        steps++
      },
      20,
      { subSteps: 3 },
    )
    globalThis.setInterval = nativeInterval
    const run = (delay: number) => {
      wall = room.clock.currentTime + delay
      const before = steps
      callback?.()
      results.push(steps - before)
    }
    run(0)
    run(0)
    run(100)
    run(250)
    run(1000)
    room.clock.start()
    run(0)
  } finally {
    Date.now = nativeNow
    globalThis.setInterval = nativeInterval
    // The normal native disposal method must clear its real interval and stop the clock.
    await new Promise<void>((resolve) => {
      const events = Reflect.get(room, '_events')
      events.once('disconnect', resolve)
      events.emit('dispose')
    })
  }
  if (JSON.stringify(results) !== JSON.stringify([1, 1, 2, 5, 5, 1])) {
    throw new Error(`Fixed-step clock lost time or failed its catch-up cap: ${results}`)
  }
  if (room.clock.running || Reflect.get(room, '_simulationInterval') !== undefined) {
    throw new Error('Disposed room retained its clock or simulation interval')
  }
  return { steps: results, disposed: true }
}
