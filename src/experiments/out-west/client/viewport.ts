import { type Entity, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, Vec3 } from 'playcanvas'
import { type FrontierSettings, loadSettings } from '../ffa/client/settings.ts'
import { BankGuide } from '../ffa/client/wayfinding.ts'
import { canFire } from '../ffa/sim/combat.ts'
import { zoneAt } from '../ffa/sim/layout.ts'
import type { World } from '../ffa/sim/state.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { CollisionData, PlayerInput, PlayerState } from '../runtime/protocol.ts'
import { Buttons } from '../runtime/protocol.ts'
import { Actors, type Appearance } from './actors.ts'
import { GameApplication } from './application.ts'
import { GameEffects } from './effects.ts'
import { GameInput } from './input.ts'
import { FrontierItems } from './items.ts'
import { NativeRagdolls } from './ragdolls.ts'
import { aimedTarget } from './targeting.ts'
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
  firstPerson?: boolean
  onState?: (player: PlayerState, players: number) => void
  onReady?: () => void
  onError?: (error: unknown) => void
}
export interface GameViewport {
  ready: Promise<void>
  destroy: () => void
  firstPerson: (value: boolean) => void
  configure: (settings: FrontierSettings) => void
  inputEnabled: (value: boolean) => void
  tap: (bit: number) => void
  event: (event: SimEvent) => void
  aimPoint: () => { x: number; y: number; shooter: boolean }
  debug: () => {
    fps: number
    worstFps: number
    pixelRatio: number
    players: number
    drawCalls: number
    windows: { total: number; intact: number }
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
  trace: GameSession['cameraTrace']
}): void {
  const { camera, player, input, settings, first, trace } = options
  head.set(player.x, player.y + 0.65, player.z)
  const cp = Math.cos(input.pitch)
  target.set(
    head.x - Math.sin(input.yaw) * cp * 20,
    head.y + Math.sin(input.pitch) * 20,
    head.z - Math.cos(input.yaw) * cp * 20,
  )
  if (first) {
    eye.copy(head)
  } else {
    eye.set(
      head.x + Math.sin(input.yaw) * cp * 4.5 + Math.cos(input.yaw) * settings.shoulder * 0.6,
      head.y - Math.sin(input.pitch) * 4.5 + 0.5,
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

/** The viewport consumes either a Colyseus session or a local native-physics session. */
export function mountGameViewport(root: HTMLElement, options: ViewportOptions): GameViewport {
  const canvas = document.createElement('canvas')
  canvas.className = 'pc-game-canvas'
  canvas.setAttribute('aria-label', 'Out West game')
  root.append(canvas)
  let application: GameApplication | undefined
  let session: GameSession | undefined
  let actors: Actors | undefined
  let input: GameInput | undefined
  let effects: GameEffects | undefined
  let ragdolls: NativeRagdolls | undefined
  let items: FrontierItems | undefined
  let guide: BankGuide | undefined
  let windows: BreakableWindows | undefined
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
    if (playing && effects?.predictShot(combat, intent)) {
      actors?.fire(session.selfId)
    }
    if (playing) {
      session.update(Math.min(dt, 0.1), intent)
    }
    actors?.update(session.players, dt, first ? session.selfId : undefined)
    items?.update(session.world)
    windows?.update(session.world?.glass)
    const player = session.players.get(session.selfId)
    if (!player) {
      return
    }
    placeCamera({
      camera: application.camera,
      player,
      input,
      settings,
      first,
      trace: session.cameraTrace,
    })
    const domain = session.world?.players[Number(session.selfId)]
    if (application.camera.camera && domain && session.world) {
      guide?.update(
        application.camera.camera,
        domain.x,
        domain.z,
        domain.carried,
        domain.alive,
        Boolean(zoneAt(session.world.layout, domain.x, domain.z)),
        dt,
      )
    }
    options.onState?.(player, session.players.size)
  }
  const ready = (async () => {
    const created = await GameApplication.create({ canvas, viewport: root })
    application = created
    if (lifecycle.signal.aborted) {
      created.destroy()
      return
    }
    try {
      const createdSession = await options.createSession()
      session = createdSession
      if (lifecycle.signal.aborted) {
        createdSession.dispose()
        return
      }
      const town = await created.instantiate(options.townUrl, 'town')
      windows = new BreakableWindows(town)
      if (lifecycle.signal.aborted) {
        return
      }
      ragdolls = await NativeRagdolls.create(created, options.collision)
      actors = new Actors(created, ragdolls, session.appearance, () => session?.world)
      await actors.initialize(session.players)
      input = new GameInput(canvas, root)
      const initial = session.players.get(session.selfId)
      if (initial) {
        input.yaw = initial.yaw
        input.pitch = initial.pitch
      }
      input.configure(settings)
      input.setEnabled(false)
      effects = new GameEffects(created)
      await effects.ready
      if (session.world) {
        items = await FrontierItems.create(created)
        guide = new BankGuide(root, session.world.grid)
      }
      created.app.on('update', update)
      await new Promise<void>((resolve) => {
        created.app.once('postrender', resolve)
        lifecycle.signal.addEventListener('abort', () => resolve(), { once: true })
      })
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
    guide?.destroy()
    effects?.destroy()
    actors?.destroy()
    ragdolls?.destroy()
    session?.dispose()
    application?.destroy()
    canvas.remove()
  }
  return {
    ready,
    destroy,
    event(event) {
      effects?.event(event)
      if (event.type === 'shot') {
        actors?.fire(String(event.shooter))
      }
    },
    configure(value) {
      settings = value
      first = value.view === 'first'
      input?.configure(value)
    },
    inputEnabled(value) {
      input?.setEnabled(value)
    },
    tap(bit) {
      input?.tap(bit)
    },
    firstPerson(value) {
      first = value
      settings = { ...settings, view: value ? 'first' : 'third' }
    },
    aimPoint: () => ({
      x: settings.view === 'top' ? (input?.cursor.x ?? innerWidth / 2) : innerWidth / 2,
      y: settings.view === 'top' ? (input?.cursor.y ?? innerHeight / 2) : innerHeight / 2,
      shooter: settings.view !== 'top',
    }),
    debug: () => ({
      fps: application?.quality.fps ?? 0,
      worstFps: application?.quality.worstFps ?? 0,
      pixelRatio: application?.quality.pixelRatio ?? 0,
      players: session?.players.size ?? 0,
      windows: windows?.stats() ?? { total: 0, intact: 0 },
      actors: actors?.stats() ?? { loaded: 0, loading: 0, failed: 0, fallbacks: 0, visible: 0 },
      drawCalls: application?.app.stats.drawCalls.total ?? 0,
      ragdolls: ragdolls?.stats() ?? { active: 0, frozen: 0, bodies: 0 },
    }),
  }
}
