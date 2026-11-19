import { Vec3 } from 'playcanvas'
import { NativeAtmosphere } from '../duel/native-atmosphere.ts'
import { TOWN } from '../ffa/sim/layout.ts'
import type { World } from '../ffa/sim/state.ts'
import type { CollisionData, PlayerInput, PlayerState } from '../runtime/protocol.ts'
import { Actors, type Appearance, type PreparedCharacters } from './actors.ts'
import type { GameApplication } from './application.ts'
import { NativeEnvironment } from './environment.ts'
import { type BreakableProps, prepareProps } from './environment-response.ts'
import { FrontierItems } from './items.ts'
import type { NativeRagdolls } from './ragdolls.ts'
import { shotVisuals } from './shot-visuals.ts'
import { BreakableWindows } from './windows.ts'

export interface FrontierSceneState {
  readonly world?: World
  readonly selfId: string
  readonly players: ReadonlyMap<string, PlayerState>
  appearance?: (id: string) => Appearance | undefined
}

interface SceneLoad {
  townUrl: string
  collision: CollisionData
  prepareAppearance?: (signal: AbortSignal) => Promise<Appearance | undefined>
  prepareAudio: () => Promise<void>
  onStage?: (stage: string) => void
}

/** Native presentation resources. Input, audio playback, networking and the HUD belong to the host. */
export class FrontierScene {
  actors: Actors | undefined
  windows: BreakableWindows | undefined
  props: BreakableProps | undefined
  ragdolls: NativeRagdolls | undefined
  private items: FrontierItems | undefined
  private environment: NativeEnvironment | undefined
  private atmosphere: NativeAtmosphere | undefined
  private prepared: PreparedCharacters | undefined

  private readonly game: GameApplication
  private readonly signal: AbortSignal

  constructor(game: GameApplication, signal: AbortSignal) {
    this.game = game
    this.signal = signal
  }

  async load(options: SceneLoad) {
    const { game, signal } = this
    options.onStage?.('Loading the streets…')
    const [loaded, appearance] = await Promise.all([
      loadTown(game, options.townUrl, signal).then((result) => {
        this.environment = ownAfterLoad(signal, result.environment, (resource) =>
          resource.destroy(),
        )
        return result
      }),
      options.prepareAppearance?.(signal),
    ])
    signal.throwIfAborted()
    const windows = new BreakableWindows(loaded.town)
    this.windows = windows
    const scenery = await prepareProps(game, loaded.town, {
      windows,
      collision: options.collision,
      signal,
    })
    if (!scenery) {
      return
    }
    this.ragdolls = scenery.ragdolls
    this.props = scenery.props
    options.onStage?.('Getting your rider and gear ready…')
    const prepared = ownAfterLoad(signal, await Actors.prepare(game, appearance), (resource) =>
      resource.dispose(),
    )
    this.prepared = prepared
    await options.prepareAudio()
    signal.throwIfAborted()
    this.items = ownAfterLoad(signal, await FrontierItems.create(game), (resource) =>
      resource.destroy(),
    )
    this.atmosphere = await prepareAtmosphere(game, signal)
    await warmFrontierCharacters(game, prepared, { atmosphere: this.atmosphere, signal, windows })
    signal.throwIfAborted()
  }

  async bind(state: FrontierSceneState, showRiderFailure: (visible: boolean) => void) {
    const { game, ragdolls, windows, items, prepared, props, signal } = this
    signal.throwIfAborted()
    if (!(ragdolls && windows && items && prepared && props)) {
      throw new Error('Frontier scene is not ready')
    }
    props.update(state.world)
    const actors = new Actors(game, ragdolls, {
      appearance: (id) => state.appearance?.(id),
      world: () => state.world,
      showFailure: showRiderFailure,
    })
    this.actors = actors
    await actors.initialize(state.players, state.selfId, prepared)
    this.prepared = undefined
    signal.throwIfAborted()
    return { actors, windows, items, props }
  }

  present(
    state: FrontierSceneState,
    dt: number,
    { first, intent, aim }: { first: boolean; intent: PlayerInput; aim: boolean },
  ) {
    this.actors?.update(state.players, dt, first ? state.selfId : undefined)
    this.actors?.aim(intent, aim, dt)
    this.atmosphere?.update(dt)
    this.items?.update(state.world)
    this.windows?.update(state.world?.glass, state.world?.grid.glass)
    this.props?.update(state.world)
    this.environment?.syncTumbleweeds(state.world, dt)
  }

  discardItemsWithoutWorld(world: World | undefined) {
    if (!world) {
      this.items?.destroy()
      this.items = undefined
    }
  }

  destroy() {
    this.items?.destroy()
    this.props?.destroy()
    this.environment?.destroy()
    this.atmosphere?.destroy()
    this.windows?.destroy()
    this.actors?.destroy()
    this.prepared?.dispose()
    this.ragdolls?.destroy()
  }
}

async function warmCharacter(
  application: GameApplication,
  prepared: PreparedCharacters,
  { signal, windows }: { signal: AbortSignal; windows: BreakableWindows },
): Promise<void> {
  const spawn = TOWN.spawns[0]
  if (!spawn) {
    throw new Error('The town has no arrival point.')
  }
  prepared.root.enabled = true
  prepared.root.setPosition(spawn.x, 0, spawn.z)
  application.camera.setPosition(spawn.x + 3, 2, spawn.z + 5)
  application.camera.lookAt(new Vec3(spawn.x, 1, spawn.z))
  // Render real PBR/skin/shot variants behind loading before reserving a live player.
  const glass = windows.stageShardWarmup()
  try {
    await shotVisuals(application).warm({ x: spawn.x, y: 1.3, z: spawn.z })
  } finally {
    glass?.destroy()
  }
  await firstFrame(application, signal)
  await firstFrame(application, signal)
}

async function loadTown(application: GameApplication, url: string, signal: AbortSignal) {
  const town = await application.instantiate(url, 'town')
  const environment = new NativeEnvironment(application, true)
  try {
    environment.attach(town, await application.loadContainer(url))
    await environment.ready
    signal.throwIfAborted()
    return { town, environment }
  } catch (error) {
    environment.destroy()
    throw error
  }
}

async function prepareAtmosphere(
  application: GameApplication,
  signal: AbortSignal,
): Promise<NativeAtmosphere | undefined> {
  if (!TOWN.ambient || signal.aborted) {
    return undefined
  }
  const atmosphere = new NativeAtmosphere(application)
  const abort = () => atmosphere.destroy()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await atmosphere.load(TOWN.ambient)
    if (signal.aborted) {
      return undefined
    }
    atmosphere.arrange(TOWN.ambient)
    return atmosphere
  } catch (error) {
    atmosphere.destroy()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
async function warmFrontierView(
  application: GameApplication,
  signal: AbortSignal,
  side: -1 | 1,
): Promise<void> {
  if (signal.aborted) {
    return
  }
  const x = TOWN.size * (0.5 + side * 0.36)
  const z = TOWN.size * (0.5 + side * 0.47)
  application.camera.setPosition(x, 2.2, z)
  application.camera.lookAt(x, 1.2, TOWN.size / 2)
  await firstFrame(application, signal)
}

async function warmFrontierCharacters(
  application: GameApplication,
  prepared: PreparedCharacters,
  {
    atmosphere,
    signal,
    windows,
  }: { atmosphere: NativeAtmosphere | undefined; signal: AbortSignal; windows: BreakableWindows },
): Promise<void> {
  // The arrival view leaves most of the perimeter outside the camera frustum.
  await warmFrontierView(application, signal, -1)
  await warmFrontierView(application, signal, 1)
  if (signal.aborted) {
    return
  }
  const spawn = TOWN.spawns[0]
  const restore = spawn ? atmosphere?.warm(spawn.x, 0, spawn.z) : undefined
  try {
    await warmCharacter(application, prepared, { signal, windows })
  } finally {
    restore?.()
  }
}

export function firstFrame(application: GameApplication, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      application.app.off('postrender', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    application.app.once('postrender', done)
    if (signal.aborted) {
      done()
    } else {
      signal.addEventListener('abort', done, { once: true })
    }
  })
}

function ownAfterLoad<T>(signal: AbortSignal, value: T, dispose: (value: T) => void): T {
  if (signal.aborted) {
    dispose(value)
    signal.throwIfAborted()
  }
  return value
}
