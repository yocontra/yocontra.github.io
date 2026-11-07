/** In-page local authoritative lobby, exposing only deterministic motion-test setup. */
import type { Matrix4, Object3D, PerspectiveCamera } from 'three'
import type { LobbyCore, Session } from '../../api/src/town/core.ts'
import { NONE, POS_SCALE } from '../../src/experiments/out-west/contract/town.ts'
import type { FrontierGame } from '../../src/experiments/out-west/ffa/client/game.ts'
import { LoopbackServer } from '../../src/experiments/out-west/ffa/client/loopback-server.ts'
import type {
  Transport,
  TransportEvents,
} from '../../src/experiments/out-west/ffa/client/transport.ts'
import { GRAVITY, TICK_MS } from '../../src/experiments/out-west/ffa/sim/constants.ts'
import { killPlayer } from '../../src/experiments/out-west/ffa/sim/death.ts'
import {
  type InputBatcher,
  MAX_AHEAD_FRAMES,
  seqDiff,
} from '../../src/experiments/out-west/ffa/sim/input.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'

let server: LoopbackServer | null = null
export function deathLoopback(events: TransportEvents): Transport {
  const current = new LoopbackServer({ bots: 0, seed: 7, spawn: { x: 72, z: 69 } }, (data) => {
    events.onMessage(typeof data === 'string' ? data : data.slice().buffer)
  })
  server = current
  queueMicrotask(() => {
    current.start()
    events.onState('open')
  })
  return {
    kind: 'loopback',
    send: (data) => current.receive(typeof data === 'string' ? data : data.slice().buffer),
    close: () => {
      current.stop()
      events.onState('closed')
    },
  }
}
function context(): { game: FrontierGame; core: LobbyCore; server: LoopbackServer } {
  const game = Reflect.get(globalThis, '__qualityDeathGame') as FrontierGame
  if (!(server && game)) {
    throw new Error('Missing authoritative local fixture')
  }
  return { game, core: Reflect.get(server, 'core') as LobbyCore, server }
}
interface Position {
  x: number
  y: number
  z: number
}
interface RenderedMember {
  generation: number
  look: { key: string }
  vatKey: string
  suppressed: boolean
  rank: number
  actor: unknown
  lastPlayer: Position | null
  verticalSpeed: number
  wasNear: boolean
  holder: Object3D | null
  farPose: { world: Matrix4 } | null
}
export interface FallTrace {
  at: number
  tick: number
  wireTick: number
  pending: number
  inputLead: number
  authority: Position & { vy: number; grounded: boolean }
  wire: Position & { vy: number }
  predicted: Position & { vy: number; grounded: boolean }
  rendered: Position
  source: { feetY: number; rootY: number; vy: number; near: boolean } | null
  diagnostic?: {
    alive: boolean
    hp: number
    lastDamageTick: number
    respawnTick: number
    activePlayers: number
    cameraDistance: number
    representation: {
      generation: number
      look: string
      rank: number
      near: boolean
      actor: boolean
      attached: boolean
      visible: boolean
      suppressed: boolean
      vatReady: boolean
      vatPending: boolean
    } | null
  }
}

/** Read actual inputs, metre-valued snapshots, displayed feet and the source used by capture. */
export function fallTrace(): FallTrace {
  const { game, core } = context()
  const player = core.world.players[game.net.you]
  const self = game.net.self
  const rendered = game.posOf(game.net.you)
  const sessions = Reflect.get(core, 'sessions') as Map<number, Session>
  const session = sessions.get(game.net.you)
  const batcher = Reflect.get(game.net, 'batcher') as InputBatcher
  const pending = Reflect.get(game.net, 'pending') as readonly unknown[]
  const crowd = Reflect.get(game, 'crowd') as {
    members: Map<number, RenderedMember>
    vats: Map<string, unknown>
    vatLoading: Map<string, unknown>
  }
  const member = crowd.members.get(game.net.you)
  if (!(player && self && rendered && session)) {
    throw new Error('Missing authoritative fall state')
  }
  const root = member?.wasNear ? member.holder?.matrixWorld : member?.farPose?.world
  const camera = (Reflect.get(game, 'cam') as { camera: PerspectiveCamera }).camera
  return {
    at: performance.now(),
    tick: core.world.tick,
    wireTick: game.net.lastTick,
    pending: pending.length,
    inputLead: seqDiff(batcher.nextSeq, (session.queue.lastSeq + 1) & 0xff_ff),
    authority: { x: player.x, y: player.y, z: player.z, vy: player.vy, grounded: player.grounded },
    wire: { x: self.x / POS_SCALE, y: self.y, z: self.z / POS_SCALE, vy: self.vy },
    predicted: {
      x: game.net.pred.x,
      y: game.net.pred.y,
      z: game.net.pred.z,
      vy: game.net.pred.vy,
      grounded: game.net.pred.grounded,
    },
    rendered: { ...rendered },
    source:
      member?.lastPlayer && root
        ? {
            feetY: member.lastPlayer.y,
            rootY: root.elements[13],
            vy: member.verticalSpeed,
            near: member.wasNear,
          }
        : null,
    diagnostic: {
      alive: player.alive,
      hp: player.hp,
      lastDamageTick: player.lastDamageTick,
      respawnTick: player.respawnTick,
      activePlayers: core.world.players.filter((candidate) => candidate?.alive).length,
      cameraDistance: Math.hypot(
        camera.position.x - rendered.x,
        camera.position.y - rendered.y,
        camera.position.z - rendered.z,
      ),
      representation: member
        ? {
            generation: member.generation,
            look: member.look.key,
            rank: member.rank,
            near: member.wasNear,
            actor: Boolean(member.actor),
            attached: Boolean(member.holder?.parent),
            visible: member.holder?.visible ?? false,
            suppressed: member.suppressed,
            vatReady: crowd.vats.has(member.vatKey),
            vatPending: crowd.vatLoading.has(member.vatKey),
          }
        : null,
    },
  }
}
function acknowledged(state: FallTrace): boolean {
  return (
    state.pending <= MAX_AHEAD_FRAMES &&
    state.inputLead >= 0 &&
    state.inputLead <= MAX_AHEAD_FRAMES &&
    Math.abs(state.wire.y - state.authority.y) <= 0.025 &&
    state.source !== null &&
    Math.abs(state.source.feetY - state.rendered.y) < 0.025 &&
    Math.abs(state.source.rootY - state.rendered.y) < 0.025
  )
}
export function fallCoherent(state: FallTrace, threshold: number): boolean {
  // Replayed inputs lead authority; one extra tick covers the current render interpolation.
  const leadS = ((state.inputLead + 1) * TICK_MS) / 1000
  const margin = Math.abs(state.authority.vy) * leadS + (GRAVITY * leadS * leadS) / 2 + 0.25
  return (
    acknowledged(state) &&
    !state.authority.grounded &&
    !state.predicted.grounded &&
    state.authority.vy < threshold &&
    state.wire.vy < threshold &&
    Math.abs(state.rendered.y - state.authority.y) <= margin &&
    state.source !== null &&
    state.source.vy < -0.1 &&
    Math.abs(state.source.vy - state.predicted.vy) < 3
  )
}
export async function renderedUntil(
  check: (state: FallTrace) => boolean,
  stage: string,
  read = fallTrace,
): Promise<FallTrace> {
  const started = performance.now()
  let state = read()
  const samples = [state]
  if (check(state)) {
    return state
  }
  while (performance.now() - started < 10_000) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    state = read()
    if (samples.length < 48 && samples.at(-1)?.wireTick !== state.wireTick) {
      samples.push(state)
    }
    if (check(state)) {
      return state
    }
  }
  throw new Error(
    `Fall fixture did not reach acknowledged rendered state: ${JSON.stringify({ stage, samples, last: state })}`,
  )
}
async function settleInputs(): Promise<void> {
  const { server: localServer } = context()
  localServer.receive(JSON.stringify({ type: 'practice_pause', on: false }))
  const first = fallTrace()
  await renderedUntil(
    (state) => acknowledged(state) && state.tick >= first.tick + 4,
    'settle-inputs',
  )
}
function place(start: Position, grounded: boolean): void {
  const local = context()
  const player = local.core.world.players[local.game.net.you]
  if (!player) {
    throw new Error('Missing authoritative player')
  }
  Object.assign(player, {
    ...start,
    vy: 0,
    grounded,
    roof: 0,
    support: grounded ? start.y : 0,
    climbTicks: 0,
    fallTicks: 0,
    jumpTicks: 0,
    mantleTicks: 0,
    slideTicks: 0,
    rollTicks: 0,
    airX: 0,
    airZ: 0,
    airPeakY: start.y,
  })
  Reflect.apply(Reflect.get(local.core, 'sendSnapshots'), local.core, [performance.now()])
}
/** Initial placement travels through the real snapshot/reconciliation path, never client mutation. */
export async function placeForDeath(start: Position): Promise<void> {
  await settleInputs()
  place(start, true)
  const tick = context().core.world.tick
  await renderedUntil(
    (state) =>
      acknowledged(state) &&
      state.tick >= tick + 4 &&
      Math.abs(state.rendered.y - start.y) < 0.025 &&
      Math.abs(state.source?.vy ?? Number.POSITIVE_INFINITY) < 0.2,
    'place-supported',
  )
}
export async function beginRealFall(roof = false): Promise<void> {
  await settleInputs()
  const building = TOWN.buildings.find((candidate) => candidate.id === 'saloon')
  if (!building) {
    throw new Error('Missing shared roof fixture')
  }
  const start = roof
    ? {
        x: building.x + building.w / 2,
        z: building.z - (building.roof?.overhang ?? 0) - 0.5,
        y: building.height,
      }
    : { x: 72, z: 69, y: 15 }
  place(start, false)
  const tick = context().core.world.tick
  await renderedUntil((state) => state.tick >= tick + 3 && fallCoherent(state, 0), 'begin-fall')
}
/** Kill after real gravity has accelerated the live authoritative player, then encode its dead snapshot. */
export async function killDuringRealFall(threshold = -12.7): Promise<Record<string, unknown>> {
  const { game, core, server: localServer } = context()
  const player = core.world.players[game.net.you]
  const traced = await renderedUntil((state) => fallCoherent(state, threshold), 'kill-falling')
  if (!(player && game.net.self)) {
    throw new Error('Missing authoritative falling player')
  }
  localServer.receive(JSON.stringify({ type: 'practice_pause', on: true }))
  const before = {
    serverVy: player.vy,
    wireVy: game.net.self.vy,
    predictedVy: game.net.pred.vy,
    y: player.y,
    alive: player.alive,
    trace: traced,
  }
  const crowd = Reflect.get(
    game,
    'crowd',
  ) as import('../../src/experiments/out-west/ffa/scene/crowd.ts').Crowd
  const original = crowd.captureCorpse.bind(crowd)
  let captured: Record<string, unknown> | null = null
  crowd.captureCorpse = (...args) =>
    original(...args).then((rig) => {
      if (rig) {
        captured = {
          at: performance.now(),
          identity: rig.identity,
          velocity: rig.velocity.toArray(),
          containerY: rig.root.matrixWorld.elements[13],
          dressedRootY: rig.root.children[0]?.matrixWorld.elements[13],
          hipsY: rig.links[0]?.position.y,
        }
      }
      return rig
    })
  const at = performance.now()
  Reflect.set(globalThis, '__qualityDeathAt', at)
  try {
    killPlayer(core.world, player, NONE)
    Reflect.apply(Reflect.get(core, 'sendSnapshots'), core, [performance.now()])
    const pool = Reflect.get(game, 'ragdolls') as {
      corpses: Map<number, { job: Promise<void> | null }>
    }
    await pool.corpses.get(game.net.you)?.job
  } finally {
    crowd.captureCorpse = original
  }
  return {
    before,
    captured,
    after: { wireVy: game.net.self.vy, predictedVy: game.net.pred.vy, alive: game.net.alive },
    submitMs: performance.now() - at,
  }
}
