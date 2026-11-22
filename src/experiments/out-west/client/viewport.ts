import { type Entity, Vec3 } from 'playcanvas'
import { type FrontierSettings, loadSettings } from '../ffa/client/settings.ts'
import { viewport as browserViewport } from '../ffa/client/viewport.ts'
import { BankGuide } from '../ffa/client/wayfinding.ts'
import { canFire } from '../ffa/sim/combat.ts'
import { zoneAt } from '../ffa/sim/layout.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { CollisionData, PlayerInput, PlayerState } from '../runtime/protocol.ts'
import { Buttons } from '../runtime/protocol.ts'
import { reducedMotion } from '../settings.ts'
import type { Appearance } from './actors.ts'
import { GameApplication } from './application.ts'
import { GameEffects } from './effects.ts'
import { FrontierScene, type FrontierSceneState, firstFrame } from './frontier-scene.ts'
import { GameInput } from './input.ts'
import { FollowCamera } from './player-camera.ts'
import { aimedTarget, controllerAimScale } from './targeting.ts'
import { touchActions } from './touch-actions.ts'
import { viewportDebug } from './viewport-debug.ts'
import { createEffects } from './viewport-effects.ts'

export interface GameSession extends FrontierSceneState {
  update: (dt: number, input: PlayerInput, frameTime?: number) => void
  /** Raycasts the authoritative collision scene to keep the follow camera out of walls. */
  cameraTrace?: (from: Vec3, to: Vec3) => Vec3 | null
  dispose: () => void
}
export interface ViewportOptions {
  collision: CollisionData
  townUrl: string
  playerUrl: string
  createSession: () => Promise<GameSession>
  prepareAppearance?: (signal: AbortSignal) => Promise<Appearance | undefined>
  firstPerson?: boolean
  onState?: (player: PlayerState, players: number) => void
  onReady?: () => void
  onStage?: (stage: string) => void
  onError?: (error: unknown) => void
}
type InputBlock = 'connection' | 'menu' | 'summary'

export interface GameViewport {
  /** The engine owns the context and camera listener, including manual suspension. */
  audioContext: () => AudioContext | null
  ready: Promise<void>
  destroy: () => void
  firstPerson: (value: boolean) => void
  configure: (settings: FrontierSettings) => void
  blockInput: (reason: InputBlock, blocked: boolean) => void
  resetFeedback: () => void
  tap: (bit: number) => void
  event: (event: SimEvent) => void
  aimPoint: () => { x: number; y: number; shooter: boolean; focalPixels: number }
  debug: () => ReturnType<typeof viewportDebug>
}

const target = new Vec3()
function sampleInput(
  options: {
    session: GameSession
    input: GameInput
    settings: FrontierSettings
    touch: boolean
    dt: number
  },
  camera: Entity,
  sequence: number,
): PlayerInput {
  const { session, input, settings, touch, dt } = options
  const intent = input.sample(sequence, dt, () => {
    const { world, cameraTrace } = session
    return world
      ? controllerAimScale(
          { world, selfSlot: Number(session.selfId), cameraTrace },
          { seq: sequence, yaw: input.yaw, pitch: input.pitch, moveX: 0, moveZ: 0, buttons: 0 },
        )
      : 1
  })
  if (!input.enabled) {
    return intent
  }
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

function updateGuide(
  guide: BankGuide | undefined,
  camera: Entity,
  session: GameSession,
  dt: number,
): void {
  const domain = session.world?.players[Number(session.selfId)]
  if (camera.camera && domain && session.world) {
    guide?.setGrid(session.world.grid)
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

function screenAim(
  settings: FrontierSettings,
  input: GameInput | undefined,
  application: GameApplication | undefined,
) {
  const { view } = settings
  const cursor = view === 'top' ? input?.cursor : undefined
  const fov =
    application?.camera.camera?.fov ?? (view === 'first' ? settings.fovFirst : settings.fovThird)
  const height = application?.app.graphicsDevice.clientRect.height || browserViewport.h
  return {
    x: cursor?.x ?? browserViewport.w / 2,
    y: cursor?.y ?? browserViewport.h / 2,
    shooter: view !== 'top',
    focalPixels: height / (2 * Math.tan((fov * Math.PI) / 360)),
  }
}

function createRiderNotice(root: HTMLElement, signal: AbortSignal, retryRiders: () => void) {
  const notice = document.createElement('div')
  notice.className = 'pc-game-status'
  notice.setAttribute('role', 'status')
  notice.style.cssText = 'top:auto;bottom:20px;left:50%;transform:translateX(-50%)'
  notice.hidden = true
  const message = document.createElement('span')
  message.textContent = 'Some riders are still loading.'
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = 'Retry loading riders'
  retry.addEventListener('click', retryRiders, { signal })
  notice.append(message, retry)
  root.append(notice)
  return notice
}

function ownAfterLoad<T>(signal: AbortSignal, value: T, dispose: (value: T) => void): T {
  if (signal.aborted) {
    dispose(value)
    signal.throwIfAborted()
  }
  return value
}

/** The viewport consumes either a Colyseus session or a local native-physics session. */
export function mountGameViewport(root: HTMLElement, options: ViewportOptions): GameViewport {
  const canvas = createCanvas(root)
  let application: GameApplication | undefined
  let session: GameSession | undefined
  let scene: FrontierScene | undefined
  let input: GameInput | undefined
  let effects: GameEffects | undefined
  let guide: BankGuide | undefined
  let riderNotice: HTMLElement | undefined
  const lifecycle = new AbortController()
  const signal = lifecycle.signal
  let settings = loadSettings()
  const cameraRig = new FollowCamera()
  let first = options.firstPerson ?? settings.view === 'first'
  let seq = 0
  const touch = matchMedia('(pointer: coarse)').matches
  let playing = false
  const inputBlocks = new Set<InputBlock>()
  const update = (dt: number): void => {
    if (signal.aborted || !session || !input || !application || document.hidden) {
      return
    }
    const intent = sampleInput({ session, input, settings, touch, dt }, application.camera, seq++)
    if (playing) {
      effects?.predictShot(session.world?.players[Number(session.selfId)], intent)
      session.update(Math.min(dt, 0.1), intent, application.frameTime)
    }
    scene?.present(session, dt, { first, intent, aim: playing && first && input.enabled })
    const player = session.players.get(session.selfId)
    if (!player) {
      return
    }
    cameraRig.place({
      camera: application.camera,
      player,
      input,
      settings,
      first,
      recoil: effects?.recoilPitch ?? 0,
      trace: session.cameraTrace,
      dt,
      reducedMotion: reducedMotion(),
    })
    scene?.actors?.presentFirstPerson(application.camera, dt)
    effects?.flushShot(player)
    updateGuide(guide, application.camera, session, dt)
    options.onState?.(player, session.players.size)
  }
  const ready = (async () => {
    options.onStage?.('Preparing the trail…')
    try {
      const created = await GameApplication.create({ canvas, viewport: root, frontier: true })
      application = ownAfterLoad(signal, created, (value) => value.destroy())
      const presentation = new FrontierScene(created, signal)
      scene = presentation
      await presentation.load({
        ...options,
        prepareAudio: () => GameEffects.preloadAudio(created),
      })
      signal.throwIfAborted()
      options.onStage?.('Finding your place in town…')
      const createdSession = ownAfterLoad(signal, await options.createSession(), (value) =>
        value.dispose(),
      )
      session = createdSession
      const notice = createRiderNotice(root, signal, () => presentation.actors?.retry())
      riderNotice = notice
      const scenery = await presentation.bind(createdSession, (visible) => {
        if (notice.hidden === visible) {
          notice.hidden = !visible
        }
      })
      input = createInput(canvas, root, settings, createdSession.players.get(createdSession.selfId))
      effects = createEffects(created, scenery.actors, createdSession, scenery)
      await effects.ready
      signal.throwIfAborted()
      const world = createdSession.world
      if (world) {
        guide = new BankGuide(root, world.grid)
      }
      presentation.discardItemsWithoutWorld(world)
      created.app.on('update', update)
      await firstFrame(created, signal)
      signal.throwIfAborted()
      created.quality.beginMeasurement()
      playing = true
      input.setEnabled(inputBlocks.size === 0)
      options.onReady?.()
    } catch (error) {
      if (!signal.aborted) {
        options.onError?.(error)
        destroy()
        throw error
      }
    }
  })()
  function destroy(): void {
    if (!signal.aborted) {
      lifecycle.abort()
      application?.app.off('update', update)
      input?.destroy()
      guide?.destroy()
      effects?.destroy()
      riderNotice?.remove()
      scene?.destroy()
      session?.dispose()
      application?.destroy()
      canvas.remove()
    }
  }

  return {
    audioContext: () => nativeAudioContext(application, signal),
    ready,
    destroy,
    event: (event) => effects?.event(event),
    configure(value) {
      settings = value
      first = value.view === 'first'
      input?.configure(value)
    },
    blockInput(reason, blocked) {
      if (blocked) {
        inputBlocks.add(reason)
      } else {
        inputBlocks.delete(reason)
      }
      input?.setEnabled(playing && inputBlocks.size === 0)
    },
    resetFeedback() {
      cameraRig.reset()
      effects?.reset()
      scene?.windows?.reset()
    },
    tap: (bit) => input?.tap(bit),
    firstPerson(value) {
      first = value
      settings = { ...settings, view: value ? 'first' : 'third' }
    },
    aimPoint: () => screenAim(settings, input, application),
    debug: () =>
      viewportDebug({
        application,
        session,
        windows: scene?.windows,
        actors: scene?.actors,
        ragdolls: scene?.ragdolls,
        props: scene?.props,
      }),
  }
}
