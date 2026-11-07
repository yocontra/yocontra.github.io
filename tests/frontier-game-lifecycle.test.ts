import { describe, expect, it } from 'bun:test'
import { FrontierGame } from '../src/experiments/out-west/ffa/client/game.ts'
import type {
  Transport,
  TransportEvents,
} from '../src/experiments/out-west/ffa/client/transport.ts'

interface Lifecycle {
  exited: boolean
  disposed: boolean
  running: boolean
  raf: number
  hiddenTimer: ReturnType<typeof setInterval> | null
  opts: { onIncompatible: (message: string) => void; onExit: () => void }
  net: { attach: (transport: Transport) => void }
  desk: { enabled: boolean; unlock: () => void }
}
const methods = FrontierGame.prototype as unknown as {
  onIncompatible: (this: Lifecycle, message: string) => void
  onTransport: (this: Lifecycle, state: string) => void
  start: (
    this: Lifecycle,
    connect: (events: TransportEvents) => Transport,
    onProgress: (fraction: number, label: string) => void,
  ) => Promise<void>
}

describe('Frontier version refusal during loading', () => {
  it('stops the game before presenting the notice and preserves it through the terminal close', async () => {
    const cancel = globalThis.cancelAnimationFrame
    const cancelled: number[] = []
    Reflect.set(globalThis, 'cancelAnimationFrame', (id: number) => cancelled.push(id))
    const notices: string[] = []
    let exits = 0
    let attached = 0
    let audioReleased = 0
    const game = Object.assign(Object.create(FrontierGame.prototype) as Lifecycle, {
      exited: false,
      disposed: false,
      running: true,
      raf: 42,
      hiddenTimer: setInterval(() => undefined, 1000),
      unwatchAudio: () => audioReleased++,
      opts: {
        onIncompatible: (message: string) => {
          expect(game.exited).toBe(true)
          expect(game.running).toBe(false)
          notices.push(message)
        },
        onExit: () => exits++,
      },
      net: { attach: () => attached++ },
      desk: { enabled: true, unlock: () => undefined },
    })
    try {
      methods.onIncompatible.call(game, 'Refresh to play.')
      expect(cancelled).toEqual([42])
      expect(game.desk.enabled).toBe(false)
      expect(game.hiddenTimer).toBeNull()
      methods.onTransport.call(game, 'closed')
      methods.onIncompatible.call(game, 'Duplicate refusal.')
      expect(notices).toEqual(['Refresh to play.'])
      expect(exits).toBe(0)
      expect(audioReleased).toBe(1)
      // There is deliberately no renderer/assets on this state: terminal startup must return
      // immediately, without building or warming the town or replacing its refusal overlay.
      const transport: Transport = {
        kind: 'loopback',
        send: () => undefined,
        close: () => undefined,
      }
      const progress: number[] = []
      await methods.start.call(
        game,
        () => transport,
        (fraction) => progress.push(fraction),
      )
      expect(attached).toBe(1)
      expect(progress).toEqual([])
      expect(game.running).toBe(false)
    } finally {
      if (cancel === undefined) {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame')
      } else {
        Reflect.set(globalThis, 'cancelAnimationFrame', cancel)
      }
      if (game.hiddenTimer) {
        clearInterval(game.hiddenTimer)
      }
    }
  })
})

it('keeps the loading barrier through a reconnect while dead riders are being recovered', async () => {
  let precasts = 0
  let recoveries = 0
  const state = {
    disposed: false,
    exited: false,
    connectionGeneration: 0,
    net: { persistent: { ready: true } },
    precastRiders: () => {
      precasts++
      state.net.persistent.ready = true
      return Promise.resolve()
    },
    recoverDeadRiders: () => {
      recoveries++
      if (recoveries === 1) {
        state.net.persistent.ready = false
      }
      return Promise.resolve()
    },
  }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  await Reflect.apply(Reflect.get(FrontierGame.prototype, 'finishPlayers'), state, [
    () => undefined,
  ])
  expect(precasts).toBe(2)
  expect(recoveries).toBe(2)
  expect(state.net.persistent.ready).toBe(true)
})

it('stops the loading barrier if a terminal refusal wins asynchronous dead-rider recovery', async () => {
  let precasts = 0
  const state = {
    disposed: false,
    exited: false,
    connectionGeneration: 0,
    net: { persistent: { ready: true } },
    precastRiders: () => {
      precasts++
      return Promise.resolve()
    },
    recoverDeadRiders: () => {
      state.exited = true
      state.net.persistent.ready = false
      return Promise.resolve()
    },
  }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  await Reflect.apply(Reflect.get(FrontierGame.prototype, 'finishPlayers'), state, [
    () => undefined,
  ])
  expect(precasts).toBe(1)
  expect(state.exited).toBe(true)
})

it('repeats the loading barrier when a complete reconnect becomes ready during an awaited recovery', async () => {
  let precasts = 0
  let recoveries = 0
  const state = {
    disposed: false,
    exited: false,
    connectionGeneration: 0,
    net: { persistent: { ready: true } },
    precastRiders: () => {
      precasts++
      return Promise.resolve()
    },
    recoverDeadRiders: () => {
      recoveries++
      if (recoveries === 1) {
        state.connectionGeneration++
        state.net.persistent.ready = true
      }
      return Promise.resolve()
    },
  }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  await Reflect.apply(Reflect.get(FrontierGame.prototype, 'finishPlayers'), state, [
    () => undefined,
  ])
  expect(precasts).toBe(2)
  expect(recoveries).toBe(2)
})

it('keeps loading through retained-program warming and repeats it if a new welcome wins that await', async () => {
  let complete: (() => void) | undefined
  let passes = 0
  let compiled = 0
  let finished = false
  const state = {
    disposed: false,
    exited: false,
    connectionGeneration: 0,
    net: { persistent: { ready: true }, roster: new Map([[0, {}]]) },
    precastRiders: () => Promise.resolve(),
    recoverDeadRiders: () => Promise.resolve(),
    renderer: { warmSync: () => compiled++ },
    scene: {},
    cam: { camera: {} },
    ragdolls: {
      prepareCorpses: async (_ids: Iterable<number>, compile: () => void, valid: () => boolean) => {
        passes++
        if (passes === 1) {
          await new Promise<void>((resolve) => {
            complete = resolve
          })
        }
        if (valid()) {
          compile()
        }
      },
    },
  }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  const begin = async () => {
    await Reflect.apply(Reflect.get(FrontierGame.prototype, 'finishPlayers'), state, [
      () => undefined,
    ])
    finished = true
  }
  const startup = begin()
  await Promise.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  state.connectionGeneration++
  complete?.()
  await startup
  expect(passes).toBe(2)
  expect(compiled).toBe(1)
  expect(finished).toBe(true)
})
