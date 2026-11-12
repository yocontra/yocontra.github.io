import { afterEach, expect, test as it, mock, spyOn } from 'bun:test'
import { Vec2, Vec3 } from 'playcanvas'
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { NativeDirector } from '../../src/experiments/out-west/duel/native-director.ts'

const equipment = await import('../../src/experiments/out-west/scene/native-equipment.ts')

afterEach(() => mock.restore())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function actor(enabled: boolean) {
  const state = { enabled, destroyed: false }
  return Object.assign(state, {
    root: {
      get enabled() {
        return state.enabled
      },
      set enabled(value: boolean) {
        state.enabled = value
      },
      setLocalScale: () => undefined,
    },
    destroy: () => {
      state.destroyed = true
      state.enabled = false
    },
    place: () => undefined,
    face: () => undefined,
    play: () => undefined,
    hold: () => undefined,
    idle: () => undefined,
  })
}
function fixture() {
  const actors: {
    value: ReturnType<typeof actor>
    done: ReturnType<typeof deferred<DuelActor>>
  }[] = []
  const maps: ReturnType<typeof deferred<void>>[] = []
  const lights: ReturnType<typeof deferred<void>>[] = []
  const weapons: ReturnType<typeof deferred<void>>[] = []
  const cards: string[] = []
  spyOn(DuelActor, 'create').mockImplementation((_game, _url, _name, options) => {
    const value = actor(options?.enabled ?? true)
    const done = deferred<DuelActor>()
    actors.push({ value, done })
    return done.promise
  })
  spyOn(equipment, 'attachHeldWeapon').mockImplementation(() => {
    const done = deferred<void>()
    weapons.push(done)
    return done.promise as unknown as ReturnType<typeof equipment.attachHeldWeapon>
  })
  const noop = () => undefined
  const input = { enabled: true, dispose: noop, resetToggle: noop }
  const stage = { enabled: true }
  // The real director methods run without creating a DOM, graphics device or network connection.
  const d = Object.assign(Object.create(NativeDirector.prototype), {
    epoch: 0,
    equipmentEpoch: 0,
    lifecycle: new AbortController(),
    loading: null,
    loadFailed: false,
    phase: 'lose',
    phaseT: 999,
    paused: false,
    interluding: false,
    level: 0,
    walked: 0,
    realTime: 0,
    remote: null,
    exitDuel: null,
    specialSave: null,
    player: null,
    enemy: null,
    rifleman: null,
    board: { close: noop },
    clock: { cancel: noop, dispose: noop, tick: noop, ranked: false },
    debris: { reset: noop, destroy: noop, update: noop },
    atmosphere: { arrange: noop, destroy: noop, update: noop },
    game: {
      stage,
      app: { off: noop, graphicsDevice: { width: 1280, height: 720 } },
      camera: {
        camera: { projectionOffset: Vec2.ZERO },
        getPosition: () => Vec3.ZERO,
        forward: Vec3.FORWARD,
        setPosition: noop,
        lookAt: noop,
      },
    },
    arenas: {
      life: {},
      show: () => {
        const done = deferred<void>()
        maps.push(done)
        return done.promise
      },
      lighting: () => {
        const done = deferred<void>()
        lights.push(done)
        return done.promise
      },
      destroy: noop,
    },
    c: {
      input,
      save: { legend: false, attempts: [], seenPosters: [], run: { total: 0 } },
      audio: { hushUi: noop, playSong: noop, heartbeat: noop, update: noop, setListener: noop },
      hud: {
        menuOpen: false,
        phase: noop,
        showCard: (card: { title: string }) => cards.push(card.title),
        hideCard: noop,
        setCounter: noop,
        setPurse: noop,
        clearCall: noop,
        setPips: noop,
        show: noop,
        closeMenu: noop,
        hideEnd: noop,
        update: noop,
      },
    },
    hubShot: noop,
  }) as NativeDirector
  const finishActor = (index: number) => {
    const pending = actors[index]
    if (!pending) {
      throw new Error('Missing pending actor')
    }
    pending.done.resolve(pending.value as unknown as DuelActor)
  }
  return { d, stage, input, actors, maps, lights, weapons, cards, finishActor }
}

it('keeps scene and input gated until the actor, map and lighting are ready', async () => {
  const f = fixture()
  const pending = f.d.startLevel(6)
  expect(f.d.phase).toBe('loading')
  expect(f.stage.enabled).toBe(false)
  expect(f.input.enabled).toBe(false)
  expect(f.actors[0]?.value.enabled).toBe(false)
  f.finishActor(0)
  await flush()
  expect(f.d.enemy).toBeNull()
  expect(f.lights).toHaveLength(0)
  f.maps[0]?.resolve()
  await flush()
  expect(f.lights).toHaveLength(1)
  expect(f.stage.enabled).toBe(false)
  f.lights[0]?.resolve()
  await pending
  expect(f.d.phase).toBe('poster')
  expect(f.stage.enabled).toBe(true)
  expect(f.input.enabled).toBe(true)
  expect(f.actors[0]?.value.enabled).toBe(true)
})

it('waits for the disabled Underboss rifleman and held weapon before committing', async () => {
  const f = fixture()
  const pending = f.d.startLevel(OUTLAWS.findIndex((outlaw) => outlaw.gimmick === 'underboss'))
  f.finishActor(0)
  f.maps[0]?.resolve()
  await flush()
  expect(f.actors).toHaveLength(2)
  expect(f.actors[1]?.value.enabled).toBe(false)
  f.finishActor(1)
  await flush()
  expect(f.weapons).toHaveLength(1)
  expect(f.lights).toHaveLength(0)
  expect(f.stage.enabled).toBe(false)
  f.weapons[0]?.resolve()
  await flush()
  f.lights[0]?.resolve()
  await pending
  expect(f.stage.enabled).toBe(true)
  expect(f.actors.every((candidate) => candidate.value.enabled)).toBe(true)
})

for (const oldFirst of [false, true]) {
  it(`never exposes a stale actor when the ${oldFirst ? 'old' : 'new'} load resolves first`, async () => {
    const f = fixture()
    const old = f.d.startLevel(6)
    const next = f.d.startLevel(10)
    if (oldFirst) {
      f.finishActor(0)
      f.maps[0]?.resolve()
      await old
    }
    expect(f.stage.enabled).toBe(false)
    f.finishActor(1)
    f.maps[1]?.resolve()
    await flush()
    f.lights[0]?.resolve()
    await next
    expect(f.stage.enabled).toBe(true)
    expect(f.actors[0]?.value.enabled).toBe(false)
    if (!oldFirst) {
      f.finishActor(0)
      f.maps[0]?.resolve()
      await old
    }
    expect(f.actors[0]?.value.destroyed).toBe(true)
    expect(f.actors[0]?.value.enabled).toBe(false)
    expect(f.actors[1]?.value.enabled).toBe(true)
    expect(f.d.level).toBe(10)
    expect(f.d.phase).toBe('poster')
    expect(f.stage.enabled).toBe(true)
    expect(f.input.enabled).toBe(true)
  })
}

for (const dispose of [false, true]) {
  it(`restores the stage on ${dispose ? 'disposal' : 'saloon return'} and destroys a late disabled actor`, async () => {
    const f = fixture()
    const pending = f.d.startLevel(6)
    if (dispose) {
      f.d.dispose()
    } else {
      f.d.saloon()
    }
    expect(f.stage.enabled).toBe(true)
    expect(f.actors[0]?.value.enabled).toBe(false)
    f.finishActor(0)
    f.maps[0]?.resolve()
    await pending
    expect(f.actors[0]?.value.destroyed).toBe(true)
    expect(f.actors[0]?.value.enabled).toBe(false)
    expect(f.stage.enabled).toBe(true)
    expect(f.d.enemy).toBeNull()
  })
}

it('cleans up a successful actor after map failure and retries only on a deliberate press', async () => {
  const f = fixture()
  const pending = f.d.startLevel(6)
  f.maps[0]?.reject(new Error('Map unavailable'))
  f.finishActor(0)
  await pending
  expect(f.actors[0]?.value.destroyed).toBe(true)
  expect(f.stage.enabled).toBe(false)
  expect(f.input.enabled).toBe(true)
  expect(f.d.phase).toBe('loading')
  expect(f.cards.at(-1)).toBe('COULD NOT LOAD DUEL')
  const retry = spyOn(f.d, 'retry')
  for (let n = 0; n < 30; n++) {
    f.d.update(1 / 60)
  }
  expect(retry).not.toHaveBeenCalled()
  expect(f.actors).toHaveLength(1)
  f.d.press({ action: 'fire', t: 1000, source: 'key', x: -1, y: -1 })
  expect(f.actors).toHaveLength(2)
  expect(f.input.enabled).toBe(false)
  f.finishActor(1)
  f.maps[1]?.resolve()
  await flush()
  f.lights[0]?.resolve()
  await flush()
  expect(f.d.phase).toBe('poster')
  expect(f.stage.enabled).toBe(true)
})

it('retains ownership of a previously hidden stage and disabled input', async () => {
  const f = fixture()
  f.stage.enabled = false
  f.input.enabled = false
  const pending = f.d.startLevel(6)
  f.finishActor(0)
  f.maps[0]?.resolve()
  await flush()
  f.lights[0]?.resolve()
  await pending
  expect(f.stage.enabled).toBe(false)
  expect(f.input.enabled).toBe(false)
})

it('cleans up both Underboss candidates if the held weapon fails', async () => {
  const f = fixture()
  const pending = f.d.startLevel(OUTLAWS.findIndex((outlaw) => outlaw.gimmick === 'underboss'))
  f.finishActor(0)
  f.maps[0]?.resolve()
  await flush()
  f.finishActor(1)
  await flush()
  f.weapons[0]?.reject(new Error('Weapon unavailable'))
  await pending
  expect(f.actors.every((candidate) => candidate.value.destroyed)).toBe(true)
  expect(f.stage.enabled).toBe(false)
  expect(f.d.enemy).toBeNull()
  expect(f.d.rifleman).toBeNull()
  expect(f.lights).toHaveLength(0)
})

it('keeps a lighting failure hidden and disposes the successful actor', async () => {
  const f = fixture()
  const pending = f.d.startLevel(6)
  f.finishActor(0)
  f.maps[0]?.resolve()
  await flush()
  f.lights[0]?.reject(new Error('Environment unavailable'))
  await pending
  expect(f.actors[0]?.value.destroyed).toBe(true)
  expect(f.stage.enabled).toBe(false)
  expect(f.input.enabled).toBe(true)
  expect(f.d.phase).toBe('loading')
})

it('leaves no public opponent when its factory fails after the map succeeds', async () => {
  const f = fixture()
  const pending = f.d.startLevel(6)
  f.maps[0]?.resolve()
  f.actors[0]?.done.reject(new Error('Actor unavailable'))
  await pending
  expect(f.d.enemy).toBeNull()
  expect(f.stage.enabled).toBe(false)
  expect(f.lights).toHaveLength(0)
  expect(f.cards.at(-1)).toBe('COULD NOT LOAD DUEL')
})

it('cannot resume input or begin a standoff while encounter loading is pending', async () => {
  const f = fixture()
  const pending = f.d.startLevel(6)
  f.d.paused = true
  f.d.resume()
  f.d.wait()
  expect(f.d.phase).toBe('loading')
  expect(f.input.enabled).toBe(false)
  expect(f.stage.enabled).toBe(false)
  f.finishActor(0)
  f.maps[0]?.resolve()
  await flush()
  f.lights[0]?.resolve()
  await pending
  expect(f.input.enabled).toBe(true)
})

it('ignores an old lighting completion after the new encounter has committed', async () => {
  const f = fixture()
  const old = f.d.startLevel(6)
  f.finishActor(0)
  f.maps[0]?.resolve()
  await flush()
  const next = f.d.startLevel(10)
  f.finishActor(1)
  f.maps[1]?.resolve()
  await flush()
  f.lights[1]?.resolve()
  await next
  f.lights[0]?.resolve()
  await old
  expect(f.actors[0]?.value.destroyed).toBe(true)
  expect(f.actors[1]?.value.enabled).toBe(true)
  expect(f.stage.enabled).toBe(true)
  expect(f.d.level).toBe(10)
  expect(f.d.phase).toBe('poster')
})
