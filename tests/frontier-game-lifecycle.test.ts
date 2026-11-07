import { describe, expect, it } from 'bun:test'
import { PerspectiveCamera, Scene } from 'three'
import { Renderer } from '../src/experiments/out-west/engine/render.ts'
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

it('warms the actual self fade variants in the world scene before loading completes', async () => {
  const calls: string[] = []
  const scene = {}
  const camera = {}
  const state = {
    disposed: false,
    exited: false,
    connectionGeneration: 0,
    recoverAfterWelcome: true,
    net: { you: 7, persistent: { ready: true }, roster: new Map([[7, {}]]) },
    precastRiders: () => {
      calls.push('precast')
      return Promise.resolve()
    },
    recoverDeadRiders: () => {
      calls.push('recover')
      return Promise.resolve()
    },
    scene,
    cam: { camera },
    renderer: {
      warmSync: (actualScene: object, actualCamera: object) => {
        expect(actualScene).toBe(scene)
        expect(actualCamera).toBe(camera)
        calls.push('draw')
      },
    },
    ragdolls: {
      prepareCorpses: (_ids: Iterable<number>, warm: () => void) => {
        calls.push('corpses')
        warm()
        return Promise.resolve()
      },
    },
    crowd: {
      warmFar: () => undefined,
      warmSelf: (id: number, warm: () => void) => {
        expect(id).toBe(7)
        expect(state.recoverAfterWelcome).toBe(true)
        calls.push('self')
        warm()
        warm()
      },
    },
  }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  await Reflect.apply(Reflect.get(FrontierGame.prototype, 'finishPlayers'), state, [
    () => undefined,
  ])
  expect(calls).toEqual(['precast', 'recover', 'corpses', 'draw', 'self', 'draw', 'draw'])
  expect(state.recoverAfterWelcome).toBe(false)
})

it('checks the current self materials synchronously before each world draw after a welcome', () => {
  const calls: string[] = []
  const state = {
    net: { you: 7 },
    scene: {},
    cam: { camera: {} },
    crowd: {
      warmFar: () => undefined,
      warmSelf: (id: number, warm: () => void) => {
        calls.push(`self:${id}`)
        warm()
      },
    },
    renderer: {
      warmSync: () => calls.push('warm'),
      render: (dt: number) => calls.push(`draw:${dt}`),
    },
  }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  const draw = Reflect.get(FrontierGame.prototype, 'drawFrame')
  Reflect.apply(draw, state, [0.01])
  state.net.you = 9
  Reflect.apply(draw, state, [0.02])
  Reflect.apply(draw, state, [0.03])
  expect(calls).toEqual([
    'self:7',
    'warm',
    'draw:0.01',
    'self:9',
    'warm',
    'draw:0.02',
    'self:9',
    'warm',
    'draw:0.03',
  ])
})

it('detaches and disposes the view model once on terminal teardown', () => {
  let disposals = 0
  const overlays: unknown[] = []
  const state = {
    viewModel: { dispose: () => disposals++ },
    renderer: { setOverlay: (value: unknown) => overlays.push(value) },
  }
  const dispose = Reflect.get(FrontierGame.prototype, 'disposeViewModel')
  Reflect.apply(dispose, state, [])
  Reflect.apply(dispose, state, [])
  expect(state.viewModel).toBeNull()
  expect(disposals).toBe(1)
  expect(overlays).toEqual([null])
})

function failingWarm() {
  const target = {}
  const composer = {}
  let current: object | null = target
  let failure = true
  let attempts = 0
  const state = {
    gl: {
      shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false },
      getRenderTarget: () => current,
      setRenderTarget: (value: object | null) => {
        current = value
      },
      compile: () => undefined,
      render: () => {
        if (current === composer) {
          attempts++
          if (failure) {
            failure = false
            throw new Error('driver')
          }
        }
      },
    },
    composer: { inputBuffer: composer },
  }
  return {
    warm: () =>
      Reflect.apply(Renderer.prototype.warmSync, state, [new Scene(), new PerspectiveCamera()]),
    attempts: () => attempts,
    restored: () => current === target && !state.gl.shadowMap.needsUpdate,
  }
}

it('retries an actual renderer driver failure behind loading, with restored state', async () => {
  const state = { disposed: false, exited: false }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  const fixture = failingWarm()
  const ready = await Reflect.apply(Reflect.get(FrontierGame.prototype, 'warmUntilReady'), state, [
    fixture.warm,
  ])
  expect(ready).toBe(true)
  expect(fixture.attempts()).toBe(2)
  expect(fixture.restored()).toBe(true)
})

it('does not retry a real capture failure as a graphics-driver failure', async () => {
  const state = { disposed: false, exited: false }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  const failure = new Error('capture could not retain geometry')
  let attempts = 0
  const operation = () => {
    attempts++
    return Promise.reject(failure)
  }
  const pending = Reflect.apply(Reflect.get(FrontierGame.prototype, 'warmUntilReady'), state, [
    operation,
  ])
  await expect(pending).rejects.toBe(failure)
  expect(attempts).toBe(1)
})

it('abandons a delayed warm after its connection generation changes or it is disposed', async () => {
  const state = { disposed: false, exited: false, generation: 0 }
  Object.setPrototypeOf(state, FrontierGame.prototype)
  let complete: (() => void) | undefined
  const operation = () =>
    new Promise<void>((resolve) => {
      complete = resolve
    })
  const warm = Reflect.get(FrontierGame.prototype, 'warmUntilReady')
  const first = Reflect.apply(warm, state, [operation, () => state.generation === 0])
  state.generation++
  complete?.()
  expect(await first).toBe(false)
  const second = Reflect.apply(warm, state, [operation])
  state.disposed = true
  complete?.()
  expect(await second).toBe(false)
})

it('fails soft on a driver error during live warming, then retries without a frame crash loop', () => {
  const fixture = failingWarm()
  let renders = 0
  const state = {
    warmRetryAt: 0,
    warmSelfPrograms: fixture.warm,
    renderer: { render: () => renders++ },
  }
  const draw = Reflect.get(FrontierGame.prototype, 'drawFrame')
  Reflect.apply(draw, state, [0.01])
  expect(renders).toBe(0)
  expect(fixture.attempts()).toBe(1)
  Reflect.apply(draw, state, [0.01])
  expect(fixture.attempts()).toBe(1)
  state.warmRetryAt = performance.now() - 1
  Reflect.apply(draw, state, [0.01])
  expect(fixture.attempts()).toBe(2)
  expect(renders).toBe(1)
  expect(fixture.restored()).toBe(true)
})
