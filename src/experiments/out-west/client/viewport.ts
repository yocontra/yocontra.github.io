import { type Entity, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, Vec3 } from 'playcanvas'
import { NativeAtmosphere } from '../duel/native-atmosphere.ts'
import { type FrontierSettings, loadSettings } from '../ffa/client/settings.ts'
import { BankGuide } from '../ffa/client/wayfinding.ts'
import { canFire } from '../ffa/sim/combat.ts'
import { TOWN, zoneAt } from '../ffa/sim/layout.ts'
import type { World } from '../ffa/sim/state.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { CollisionData, PlayerInput, PlayerState } from '../runtime/protocol.ts'
import { Buttons } from '../runtime/protocol.ts'
import { Actors, type Appearance, type PreparedCharacters } from './actors.ts'
import { GameApplication } from './application.ts'
import { GameEffects } from './effects.ts'
import { NativeEnvironment } from './environment.ts'
import { GameInput } from './input.ts'
import { FrontierItems } from './items.ts'
import { poseEye } from './player-pose.ts'
import { NativeRagdolls } from './ragdolls.ts'
import { shotVisuals } from './shot-visuals.ts'
import { aimedTarget } from './targeting.ts'
import { touchActions } from './touch-actions.ts'
import { BreakableWindows } from './windows.ts'

export interface GameSession {
  readonly world?: World
  readonly selfId: string
  readonly players: ReadonlyMap<string, PlayerState>
  appearance?: (id: string) => Appearance | undefined
  update: (dt: number, input: PlayerInput) => void
  /** Raycasts the authoritative collision scene to keep the follow camera out of walls. */
  cameraTrace?: (from: Vec3, to: Vec3) => Vec3 | null
  dispose: () => void
}
export interface ViewportOptions {
  collision: CollisionData
  townUrl: string
  playerUrl: string
  createSession: () => Promise<GameSession>
  prepareAppearance?: () => Promise<Appearance | undefined>
  firstPerson?: boolean
  onState?: (player: PlayerState, players: number) => void
  onReady?: () => void
  onStage?: (stage: string) => void
  onError?: (error: unknown) => void
}
export interface GameViewport {
  /** The engine owns the context and camera listener, including manual suspension. */
  audioContext: () => AudioContext | null
  ready: Promise<void>
  destroy: () => void
  firstPerson: (value: boolean) => void
  configure: (settings: FrontierSettings) => void
  inputEnabled: (value: boolean) => void
  resetFeedback: () => void
  tap: (bit: number) => void
  event: (event: SimEvent) => void
  aimPoint: () => { x: number; y: number; shooter: boolean }
  debug: () => {
    fps: number
    worstFps: number
    pixelRatio: number
    players: number
    drawCalls: number
    windows: { total: number; intact: number; shards: number }
    ragdolls: { active: number; frozen: number; bodies: number }
    actors: { loaded: number; loading: number; failed: number; fallbacks: number; visible: number }
  }
}

const head = new Vec3()
const eye = new Vec3()
const target = new Vec3()
function placeCamera(options: {
  camera: Entity
  player: PlayerState
  input: GameInput
  settings: FrontierSettings
  first: boolean
  recoil: number
  trace: GameSession['cameraTrace']
}): void {
  const { camera, player, input, settings, first, trace } = options
  const point = poseEye(player)
  head.set(point.x, point.y, point.z)
  const pitch = input.pitch + options.recoil
  const cp = Math.cos(pitch)
  target.set(
    head.x - Math.sin(input.yaw) * cp * 20,
    head.y + Math.sin(pitch) * 20,
    head.z - Math.cos(input.yaw) * cp * 20,
  )
  if (first) {
    eye.copy(head)
  } else {
    eye.set(
      head.x + Math.sin(input.yaw) * cp * 4.5 + Math.cos(input.yaw) * settings.shoulder * 0.6,
      head.y - Math.sin(pitch) * 4.5 + 0.5,
      head.z + Math.cos(input.yaw) * cp * 4.5 - Math.sin(input.yaw) * settings.shoulder * 0.6,
    )
    const hit = trace?.(head, eye)
    if (hit) {
      eye.lerp(head, hit, 0.9)
    }
  }
  camera.setPosition(eye)
  camera.lookAt(target)
  if (settings.view === 'top') {
    camera.setPosition(head.x, head.y + 30, head.z + 0.01)
    camera.lookAt(head)
  }
  const lens = camera.camera
  if (lens) {
    lens.projection = settings.view === 'top' ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE
    lens.orthoHeight = 18
    lens.fov = first ? settings.fovFirst : settings.fovThird
  }
}

function sampleInput(options: {
  session: GameSession
  input: GameInput
  settings: FrontierSettings
  camera: Entity
  sequence: number
  touch: boolean
  dt: number
}): PlayerInput {
  const { session, input, settings, camera, sequence, touch, dt } = options
  const intent = input.sample(sequence, dt)
  const before = session.players.get(session.selfId)
  if (settings.view === 'top' && input.cursorAim && before && camera.camera) {
    camera.camera.screenToWorld(input.cursor.x, input.cursor.y, 30, target)
    intent.yaw = Math.atan2(before.x - target.x, before.z - target.z)
    intent.pitch = 0
    input.yaw = intent.yaw
  }
  if (settings.autoReload && before?.ammo === 0 && intent.buttons & Buttons.fire) {
    intent.buttons |= Buttons.reload
  }
  const combat = session.world?.players[Number(session.selfId)]
  if (touch && session.world && combat) {
    input.setContext(touchActions(session.world, combat))
  }
  if (
    touch &&
    settings.autoFire &&
    session.world &&
    combat &&
    canFire(combat, true, combat.alive) &&
    aimedTarget(
      {
        world: session.world,
        selfSlot: Number(session.selfId),
        cameraTrace: session.cameraTrace,
      },
      intent,
    ) !== null
  ) {
    intent.buttons |= Buttons.fire
  }
  return intent
}

function createEffects(
  application: GameApplication,
  actors: Actors,
  session: GameSession,
  windows: BreakableWindows,
): GameEffects {
  return new GameEffects(application, {
    event: (event) => windows.event(event),
    fire: (id) => actors.fire(id),
    muzzle: (id) => actors.muzzle(id),
    trace: (from, to) => session.cameraTrace?.(from, to),
    riders: () => session.players,
    selfId: () => session.selfId,
    world: () => session.world,
    spurs: (id) => session.appearance?.(id)?.loadout.spurs,
  })
}

function createInput(
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  settings: FrontierSettings,
  initial: PlayerState | undefined,
): GameInput {
  const input = new GameInput(canvas, root)
  if (initial) {
    input.yaw = initial.yaw
    input.pitch = initial.pitch
  }
  input.configure(settings)
  input.setEnabled(false)
  return input
}

async function warmCharacter(
  application: GameApplication,
  prepared: PreparedCharacters,
  signal: AbortSignal,
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
  await shotVisuals(application).warm({ x: spawn.x, y: 1.3, z: spawn.z })
  await firstFrame(application, signal)
  await firstFrame(application, signal)
}

function updateGuide(
  guide: BankGuide | undefined,
  camera: Entity,
  session: GameSession,
  dt: number,
): void {
  const domain = session.world?.players[Number(session.selfId)]
  if (camera.camera && domain && session.world) {
    guide?.update(
      camera.camera,
      domain.x,
      domain.z,
      domain.carried,
      domain.alive,
      Boolean(zoneAt(session.world.layout, domain.x, domain.z, domain.y)),
      dt,
    )
  }
}

async function loadTown(application: GameApplication, url: string) {
  const town = await application.instantiate(url, 'town')
  const environment = new NativeEnvironment(application, true)
  try {
    environment.attach(town, await application.loadContainer(url))
    await environment.ready
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
async function warmFrontierCharacters(
  application: GameApplication,
  prepared: PreparedCharacters,
  atmosphere: NativeAtmosphere | undefined,
  signal: AbortSignal,
): Promise<void> {
  const spawn = TOWN.spawns[0]
  const restore = spawn ? atmosphere?.warm(spawn.x, 0, spawn.z) : undefined
  try {
    await warmCharacter(application, prepared, signal)
  } finally {
    restore?.()
  }
}

function firstFrame(application: GameApplication, signal: AbortSignal): Promise<void> {
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

function createCanvas(root: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'pc-game-canvas'
  canvas.setAttribute('aria-label', 'Out West game')
  root.append(canvas)
  return canvas
}

function nativeAudioContext(
  application: GameApplication | undefined,
  signal: AbortSignal,
): AudioContext | null {
  const manager = application?.app.soundManager
  return !signal.aborted && manager && !manager.suspended ? manager.context : null
}

function viewportDebug({
  application,
  session,
  windows,
  actors,
  ragdolls,
}: {
  application: GameApplication | undefined
  session: GameSession | undefined
  windows: BreakableWindows | undefined
  actors: Actors | undefined
  ragdolls: NativeRagdolls | undefined
}): ReturnType<GameViewport['debug']> {
  return {
    fps: application?.quality.fps ?? 0,
    worstFps: application?.quality.worstFps ?? 0,
    pixelRatio: application?.quality.pixelRatio ?? 0,
    players: session?.players.size ?? 0,
    windows: windows?.stats() ?? { total: 0, intact: 0, shards: 0 },
    actors: actors?.stats() ?? { loaded: 0, loading: 0, failed: 0, fallbacks: 0, visible: 0 },
    drawCalls: application?.app.stats.drawCalls.total ?? 0,
    ragdolls: ragdolls?.stats() ?? { active: 0, frozen: 0, bodies: 0 },
  }
}

/** The viewport consumes either a Colyseus session or a local native-physics session. */
export function mountGameViewport(root: HTMLElement, options: ViewportOptions): GameViewport {
  const canvas = createCanvas(root)
  let application: GameApplication | undefined
  let session: GameSession | undefined
  let actors: Actors | undefined
  let input: GameInput | undefined
  let effects: GameEffects | undefined
  let ragdolls: NativeRagdolls | undefined
  let items: FrontierItems | undefined
  let guide: BankGuide | undefined
  let windows: BreakableWindows | undefined
  let environment: NativeEnvironment | undefined
  let atmosphere: NativeAtmosphere | undefined
  let prepared: PreparedCharacters | undefined
  const lifecycle = new AbortController()
  let settings = loadSettings()
  let first = options.firstPerson ?? settings.view === 'first'
  let sequence = 0
  const touch = matchMedia('(pointer: coarse)').matches
  let playing = false
  const update = (dt: number): void => {
    if (lifecycle.signal.aborted || !session || !input || !application || document.hidden) {
      return
    }
    const intent = sampleInput({
      session,
      input,
      settings,
      camera: application.camera,
      sequence: sequence++,
      touch,
      dt,
    })
    const combat = session.world?.players[Number(session.selfId)]
    if (playing) {
      effects?.predictShot(combat, intent)
      session.update(Math.min(dt, 0.1), intent)
    }
    actors?.update(session.players, dt, first ? session.selfId : undefined)
    atmosphere?.update(dt)
    items?.update(session.world)
    windows?.update(session.world?.glass, session.world?.grid.glass)
    const player = session.players.get(session.selfId)
    if (!player) {
      return
    }
    effects?.flushShot(player)
    placeCamera({
      camera: application.camera,
      player,
      input,
      settings,
      first,
      recoil: effects?.recoilPitch ?? 0,
      trace: session.cameraTrace,
    })
    updateGuide(guide, application.camera, session, dt)
    options.onState?.(player, session.players.size)
  }
  const ready = (async () => {
    options.onStage?.('Preparing the trail…')
    const created = await GameApplication.create({ canvas, viewport: root })
    application = created
    if (lifecycle.signal.aborted) {
      created.destroy()
      return
    }
    try {
      options.onStage?.('Loading the streets…')
      const loaded = await loadTown(created, options.townUrl)
      environment = loaded.environment
      windows = new BreakableWindows(loaded.town)
      if (lifecycle.signal.aborted) {
        return
      }
      ragdolls = await NativeRagdolls.create(created, options.collision)
      windows.shatterInto(created, ragdolls)
      options.onStage?.('Getting your rider and gear ready…')
      prepared = await Actors.prepare(created, await options.prepareAppearance?.())
      await GameEffects.preloadAudio(created)
      items = await FrontierItems.create(created)
      atmosphere = await prepareAtmosphere(created, lifecycle.signal)
      await warmFrontierCharacters(created, prepared, atmosphere, lifecycle.signal)
      if (lifecycle.signal.aborted) {
        return
      }
      options.onStage?.('Finding your place in town…')
      const createdSession = await options.createSession()
      session = createdSession
      if (lifecycle.signal.aborted) {
        createdSession.dispose()
        return
      }
      actors = new Actors(
        created,
        ragdolls,
        (id) => session?.appearance?.(id),
        () => session?.world,
      )
      await actors.initialize(session.players, session.selfId, prepared)
      prepared = undefined
      input = createInput(canvas, root, settings, session.players.get(session.selfId))
      effects = createEffects(created, actors, createdSession, windows)
      await effects.ready
      if (session.world) {
        guide = new BankGuide(root, session.world.grid)
      } else {
        items.destroy()
        items = undefined
      }
      created.app.on('update', update)
      await firstFrame(created, lifecycle.signal)
      if (lifecycle.signal.aborted) {
        return
      }
      created.quality.beginMeasurement()
      playing = true
      input.setEnabled(true)
      options.onReady?.()
    } catch (error) {
      options.onError?.(error)
      destroy()
      throw error
    }
  })()
  function destroy(): void {
    if (lifecycle.signal.aborted) {
      return
    }
    lifecycle.abort()
    if (application) {
      application.app.off('update', update)
    }
    input?.destroy()
    items?.destroy()
    environment?.destroy()
    atmosphere?.destroy()
    guide?.destroy()
    effects?.destroy()
    windows?.destroy()
    actors?.destroy()
    prepared?.dispose()
    ragdolls?.destroy()
    session?.dispose()
    application?.destroy()
    canvas.remove()
  }
  return {
    audioContext: () => nativeAudioContext(application, lifecycle.signal),
    ready,
    destroy,
    event: (event) => effects?.event(event),
    configure(value) {
      settings = value
      first = value.view === 'first'
      input?.configure(value)
    },
    inputEnabled: (value) => input?.setEnabled(value),
    resetFeedback: () => effects?.reset(),
    tap: (bit) => input?.tap(bit),
    firstPerson(value) {
      first = value
      settings = { ...settings, view: value ? 'first' : 'third' }
    },
    aimPoint: () => ({
      x: settings.view === 'top' ? (input?.cursor.x ?? innerWidth / 2) : innerWidth / 2,
      y: settings.view === 'top' ? (input?.cursor.y ?? innerHeight / 2) : innerHeight / 2,
      shooter: settings.view !== 'top',
    }),
    debug: () => viewportDebug({ application, session, windows, actors, ragdolls }),
  }
}
