/** Deterministic local kill events through the actual production Frontier presentation. */
import { Box3, type PerspectiveCamera, type Scene, Vector3 } from 'three'
import {
  EV_HAT_OFF,
  EV_KILL,
  EV_SHOT,
  SELF_ALIVE,
  SHOT_HIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../src/experiments/out-west/contract/town.ts'
import type { ItemId } from '../../src/experiments/out-west/data/catalog.ts'
import type { BodyKey } from '../../src/experiments/out-west/data/outlaws.ts'
import { FrontierGame } from '../../src/experiments/out-west/ffa/client/game.ts'
import '../../src/experiments/out-west/ffa/client/index.ts'
import type { ShotImpacts } from '../../src/experiments/out-west/ffa/client/shot-impact.ts'
import type { Crowd } from '../../src/experiments/out-west/ffa/scene/crowd.ts'
import { lookFor } from '../../src/experiments/out-west/ffa/scene/looks.ts'
import {
  packShotCoord,
  type WireEvent,
} from '../../src/experiments/out-west/ffa/sim/codec-events.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { roofHeightAt } from '../../src/experiments/out-west/ffa/sim/roofshape.ts'
import { surfaceTop } from '../../src/experiments/out-west/ffa/sim/surfaces.ts'
import {
  beginRealFall,
  deathLoopback,
  fallTrace,
  killDuringRealFall,
  placeForDeath,
} from './death-server.ts'
import { corpseFrames } from './frame-mapping.ts'

export interface DeathOptions {
  base?: BodyKey
  roof?: boolean
  stairs?: boolean
  facade?: boolean
  outfit?: ItemId
  extra?: ItemId
  weapon?: number
  direction?: number
  hatless?: boolean
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
let options: DeathOptions = {}
export async function prepareDeath(far = false, settings: DeathOptions = {}): Promise<void> {
  options = settings
  document.body.replaceChildren()
  const root = document.createElement('div')
  root.id = 'quality-death'
  root.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh'
  document.body.append(root)
  const game = new FrontierGame(root, { audio: null, onExit: () => undefined })
  await game.start(
    (events) => deathLoopback(events),
    () => undefined,
  )
  await frame()
  await frame()
  game.devCloseHowTo()
  game.setView('third')
  game.devShowWeapon(settings.weapon ?? WEAPON_RIFLE)
  const crowd = Reflect.get(game, 'crowd') as Crowd
  const look = lookFor(
    [
      settings.outfit ?? 'outfit.striped-poncho',
      settings.outfit === 'outfit.gamblers-frock' ? 'gun.hardins-pair' : 'gun.engraved-ivory',
      'hat.bronze-band',
      'spurs.silver-jinglebobs',
      'holster.silver-conchos',
      settings.extra ??
        (settings.outfit === 'outfit.gamblers-frock' ? 'extra.tin-star' : 'extra.red-bandana'),
    ],
    game.net.you,
  )
  if (settings.base) {
    look.look.base = settings.base
    look.key += `/quality-base/${settings.base}`
  }
  crowd.setLook(game.net.you, look)
  await crowd.prepareLooks()
  await crowd.precast(1, game.net.you, () => 0)
  if (far) {
    crowd.near = 0
  }
  const transport = Reflect.get(game, 'transport') as { send: (data: string) => void }
  Reflect.set(globalThis, '__qualityDeathGame', game)
  if (settings.stairs) {
    const stair = game.net.grid.stairs[0]
    if (!stair) {
      throw new Error('Missing actual stair fixture')
    }
    const x = stair.x + stair.w * 0.37
    const z = stair.z + stair.d * 0.41
    await placeForDeath({ x, y: surfaceTop(stair, x, z), z })
  }
  if (settings.roof || settings.facade) {
    const building = TOWN.buildings.find((candidate) => candidate.id === 'saloon')
    if (!building) {
      throw new Error('Missing source roof fixture')
    }
    const x = building.x + building.w / 2
    const z = settings.facade
      ? building.z + building.d - 0.1
      : building.z - (building.roof?.overhang ?? 0) + 0.02
    const y = roofHeightAt(building, x, z)
    await placeForDeath({ x, y, z })
  }
  transport.send(JSON.stringify({ type: 'practice_pause', on: true }))
  await frame()
  await frame()
  game.devCloseHowTo()
  if (settings.hatless) {
    event(game, { type: EV_HAT_OFF, player: game.net.you })
  }
  const ready = game.debug()
  if (!ready.ready || ready.howto) {
    throw new Error(
      `Death fixture not ready:${JSON.stringify({ ready: ready.ready, howto: ready.howto })}`,
    )
  }
  const style = document.createElement('style')
  style.textContent =
    '#quality-death > :not(canvas),astro-dev-toolbar{visibility:hidden!important;}'
  document.head.append(style)
}
function event(game: FrontierGame, value: WireEvent): void {
  Reflect.apply(Reflect.get(game, 'onEvent'), game, [value])
}

export function triggerDeath(): Record<string, unknown> {
  const game = Reflect.get(globalThis, '__qualityDeathGame') as FrontierGame
  const self = game.net.self
  if (!self) {
    throw new Error('Missing self')
  }
  const at = game.posOf(game.net.you)
  if (!at) {
    throw new Error('Missing actual player pose')
  }
  const angle = options.direction ?? (options.roof ? -Math.PI / 2 : 0)
  const from = { x: at.x - Math.cos(angle) * 8, y: at.y, z: at.z - Math.sin(angle) * 8 }
  const original = game.posOf.bind(game)
  game.posOf = (id) => (id === 1 ? from : original(id))
  Object.defineProperty(self, 'flags', { value: self.flags & ~SELF_ALIVE, configurable: true })
  const kill: WireEvent = { type: EV_KILL, killer: 1, victim: game.net.you, flags: 0, bounty: 0 }
  const weapon = options.weapon ?? WEAPON_RIFLE
  const shot: WireEvent = {
    type: EV_SHOT,
    shooter: 1,
    aim: 0,
    range: 800,
    target: game.net.you,
    flags:
      SHOT_HIT |
      (weapon === WEAPON_RIFLE ? SHOT_RIFLE : 0) |
      (weapon === WEAPON_SHOTGUN ? SHOT_SHOTGUN : 0),
    y: Math.round((at.y + 1.35) * 10),
    ox: packShotCoord(from.x),
    oy: packShotCoord(from.y + 1.35),
    oz: packShotCoord(from.z),
    ex: packShotCoord(at.x),
    ey: packShotCoord(at.y + (options.hatless ? 1.65 : 1.3)),
    ez: packShotCoord(at.z),
    pellets: [],
  }
  const impacts = Reflect.get(game.net, 'impacts') as ShotImpacts
  impacts.remember([kill, shot], game.net.lastTick, performance.now())
  const before = performance.now()
  event(game, kill)
  event(game, shot)
  Reflect.set(globalThis, '__qualityDeathAt', before)
  return {
    tier: game.debug().tier,
    alive: game.net.alive,
    submitMs: performance.now() - before,
    at,
    from,
    weapon,
  }
}

export function deathFrame(): Record<string, unknown> {
  const game = Reflect.get(globalThis, '__qualityDeathGame') as FrontierGame
  const debug = game.debug()
  const scene = Reflect.get(game, 'scene') as Scene
  const camera = (Reflect.get(game, 'cam') as { camera: PerspectiveCamera }).camera
  let roots = 0
  const { bounds, mapping } = corpseFrames(game)
  const gear: Record<string, { visible: number; meshes: number; materials: number }> = {}
  scene.traverse((root) => {
    if (root.name !== 'dressed-corpse') {
      return
    }
    roots++
    root.traverse((node) => {
      if (!node.userData.corpseGear) {
        return
      }
      const key = String(node.userData.corpseGear)
      const found = gear[key] ?? { visible: 0, meshes: 0, materials: 0 }
      node.traverse((child) => {
        if ('isMesh' in child) {
          found.meshes++
          if (child.visible && node.visible) {
            found.visible++
          }
          found.materials++
        }
      })
      gear[key] = found
    })
  })
  const bytes = Reflect.get(globalThis, '__owTextureBytes') as (() => number) | undefined
  return {
    tier: debug.tier,
    ready: debug.ready,
    howto: debug.howto,
    view: debug.view,
    liveState: game.net.alive ? fallTrace() : null,
    actors: debug.crowd,
    ragdolls: debug.ragdolls,
    mapping,
    camera: camera.position.toArray(),
    cameraFov: camera.fov,
    corpses: roots,
    crop: screenBounds(bounds, camera),
    bodyCenter: bounds.isEmpty() ? null : bounds.getCenter(new Vector3()).toArray(),
    gear,
    textureBytes: bytes?.(),
    textures: debug.textures,
    geometries: debug.geometries,
    draws: debug.draws,
    at: game.posOf(game.net.you),
    elapsedMs:
      performance.now() - Number(Reflect.get(globalThis, '__qualityDeathAt') ?? performance.now()),
  }
}

interface Recording {
  recorder: MediaRecorder
  chunks: Blob[]
  stream: MediaStream
  frameTimes: number[]
  frame: number
  last: number
  mime: string
}
let recording: Recording | null = null
export function startDeathVideo(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('.fr-canvas')
  if (!canvas) {
    throw new Error('Missing production canvas')
  }
  const stream = canvas.captureStream(30)
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm;codecs=vp8'
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000 })
  const state: Recording = {
    recorder,
    chunks: [],
    stream,
    frameTimes: [],
    frame: 0,
    last: performance.now(),
    mime,
  }
  recorder.ondataavailable = (chunk) => {
    if (chunk.data.size > 0) {
      state.chunks.push(chunk.data)
    }
  }
  const sample = (now: number) => {
    state.frameTimes.push(now - state.last)
    state.last = now
    state.frame = requestAnimationFrame(sample)
  }
  state.frame = requestAnimationFrame(sample)
  recording = state
  recorder.start()
}
export async function stopDeathVideo(): Promise<{
  url: string
  frameTimes: number[]
  mime: string
}> {
  const state = recording
  if (!state) {
    throw new Error('No native recording')
  }
  const finished = new Promise<void>((resolve) =>
    state.recorder.addEventListener('stop', () => resolve(), { once: true }),
  )
  state.recorder.stop()
  await finished
  cancelAnimationFrame(state.frame)
  for (const track of state.stream.getTracks()) {
    track.stop()
  }
  const blob = new Blob(state.chunks, { type: state.mime })
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Missing encoded recording'))
    reader.readAsDataURL(blob)
  })
  recording = null
  return { url, frameTimes: state.frameTimes, mime: state.mime }
}

function screenBounds(bounds: Box3, camera: PerspectiveCamera): number[] | null {
  if (bounds.isEmpty()) {
    return null
  }
  bounds.expandByScalar(0.35)
  const screen = new Box3()
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        screen.expandByPoint(new Vector3(x, y, z).project(camera))
      }
    }
  }
  return [screen.min.x, screen.min.y, screen.max.x, screen.max.y]
}

export function startAuthoritativeFall(roof = false): Promise<void> {
  return beginRealFall(roof)
}
export function finishAuthoritativeFall(threshold = -12.7): Promise<Record<string, unknown>> {
  return killDuringRealFall(threshold)
}
