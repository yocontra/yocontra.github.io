import { type Entity, Vec3 } from 'playcanvas'
import { BotDirector, freshBotName } from '../../../../api/src/town/bots.ts'
import { applyPractice, stakeRespawns } from '../../../../api/src/town/practice.ts'
import { ANGLE_SCALE, type ServerControl } from '../contract/town.ts'
import { DEFAULT_LOADOUT } from '../data/catalog.ts'
import {
  loadRecord,
  PRACTICE_PURSE_CAP,
  patchRecord,
  practiceBots,
  practiceOptions,
} from '../ffa/client/practice.ts'
import type { World } from '../ffa/sim/state.ts'
import type { InputFrame, SimEvent } from '../ffa/sim/types.ts'
import { addPlayer } from '../ffa/sim/world.ts'
import { loadAmmo } from '../runtime/ammo.ts'
import { createFrontierSimulation } from '../runtime/frontier.ts'
import { type CollisionData, type PlayerInput, SIMULATION_HZ } from '../runtime/protocol.ts'
import { ShowdownJudge } from '../runtime/showdown.ts'
import { ownPresentation } from './player-pose.ts'
import { ShowdownInput } from './showdown-input.ts'
import type { GameSession } from './viewport.ts'

export interface FrontierSession extends GameSession {
  readonly world: World
  readonly selfSlot: number
  readonly banked: number
  readonly practice: boolean
  readonly lobbyId: string
  control: (text: string) => void
  subscribeControl: (listener: (control: ServerControl) => void) => () => void
  subscribe: (listener: (event: SimEvent) => void) => () => void
}

export function domainInput(input: PlayerInput, seq: number, tick: number): InputFrame {
  const buttons = input.buttons
  const turns = (-input.yaw - Math.PI / 2) / (Math.PI * 2)
  const aim = Math.round((((turns % 1) + 1) % 1) * ANGLE_SCALE) % ANGLE_SCALE
  return {
    seq,
    moveX: Math.round(input.moveX * 127),
    moveZ: Math.round(input.moveZ * 127),
    aim,
    pitch: Math.round((input.pitch / (Math.PI / 2)) * 127),
    buttons,
    viewTime: tick,
  }
}

function syncPoses(simulation: ReturnType<typeof createFrontierSimulation>): void {
  for (const player of simulation.world.players) {
    const pose = player ? simulation.physics.players.get(String(player.id)) : undefined
    if (player && pose) {
      pose.hp = player.hp
      pose.ammo = player.ammo
    }
  }
}

type PlayerState = import('../runtime/protocol.ts').PlayerState
/**
 * Present every rider between the previous and current fixed step, as the online SDK reconciler
 * does: 20 Hz authority must not draw as 20 Hz stair steps. Respawns and teleports cut.
 */
class TickPresentation {
  readonly poses: Map<string, PlayerState>
  private readonly origins = new Map<string, { x: number; y: number; z: number; life: number }>()
  private readonly bodies: ReadonlyMap<string, PlayerState>
  private readonly world: World
  private readonly selfId: string
  constructor(bodies: ReadonlyMap<string, PlayerState>, world: World, selfId: string) {
    this.bodies = bodies
    this.world = world
    this.selfId = selfId
    this.poses = new Map(bodies)
  }
  private life(id: string): number {
    return this.world.players[Number(id)]?.spawnTick ?? -1
  }
  /** Call before each fixed step. */
  capture(): void {
    this.origins.clear()
    for (const [id, body] of this.bodies) {
      this.origins.set(id, { x: body.x, y: body.y, z: body.z, life: this.life(id) })
    }
  }
  present(alpha: number, input: PlayerInput): void {
    this.poses.clear()
    for (const [id, body] of this.bodies) {
      const from = this.origins.get(id)
      const pose = { ...body }
      if (
        from &&
        from.life === this.life(id) &&
        Math.hypot(body.x - from.x, body.y - from.y, body.z - from.z) < 2
      ) {
        pose.x = from.x + (body.x - from.x) * alpha
        pose.y = from.y + (body.y - from.y) * alpha
        pose.z = from.z + (body.z - from.z) * alpha
      }
      this.poses.set(id, id === this.selfId ? ownPresentation(pose, input) : pose)
    }
  }
}

interface LocalSessionOptions {
  bots?: number
  seed?: number
  cluster?: boolean
  spawn?: { x: number; z: number }
  name?: string
}

/** Full Frontier domain rules and bots use the same native motor as online matches. */
export async function createLocalFrontierSession(
  collision: CollisionData,
  options: LocalSessionOptions = {},
): Promise<FrontierSession> {
  const simulation = createFrontierSimulation({
    ammo: await loadAmmo(),
    collision,
    seed: options.seed ?? 7,
    practice: true,
  })
  const world = simulation.world
  const selfSlot = addPlayer(world, {
    accountId: 'local',
    name: options.name ?? 'You',
    level: 1,
    prestige: 0,
    bot: false,
  })
  const selfId = String(selfSlot)
  const bots = new BotDirector(world.seed)
  const record = loadRecord()
  let rules = practiceOptions(record)
  let banked = record.purse
  applyPractice(world, bots, rules)
  const stress = import.meta.env.DEV || import.meta.env.PUBLIC_OW_PERF_HARNESS === '1'
  for (let i = 0; i < practiceBots(options.bots, Boolean(stress)); i++) {
    addPlayer(world, {
      accountId: `bot-${i}`,
      name: freshBotName(
        i,
        new Set(world.players.flatMap((player) => (player ? [player.name] : []))),
      ),
      level: 1 + (i % 5),
      prestige: 0,
      bot: true,
    })
  }
  const self = world.players[selfSlot]
  if (self && options.spawn) {
    Object.assign(self, { x: options.spawn.x, z: options.spawn.z })
  }
  if (stress && options.cluster) {
    bots.rally = selfSlot
    for (const player of world.players) {
      if (player?.bot && self) {
        const angle = player.id * 2.399_963
        const radius = 4 + (player.id % 6)
        player.x = self.x + Math.cos(angle) * radius
        player.z = self.z + Math.sin(angle) * radius
      }
    }
  }
  const listeners = new Set<(event: SimEvent) => void>()
  const frames: (InputFrame | null)[] = Array.from({ length: 32 }, () => null)
  let elapsed = 0
  let seq = 0
  let disposed = false
  const deposits = new Set<number>()
  const controls = new Set<(control: ServerControl) => void>()
  let paused = false
  const judge = new ShowdownJudge(world.seed)
  const showdownInput = new ShowdownInput({
    world,
    self: selfSlot,
    send(text) {
      const message = JSON.parse(text) as { showdownId: number; localMs: number | null }
      judge.shot(message.showdownId, selfSlot, message.localMs, performance.now())
    },
  })
  const judgeHost = {
    world,
    sessionOf(id: number) {
      return id === selfSlot
        ? {
            rtt: [],
            tcpRtt: null,
            peer: {
              send(text: string) {
                const control = JSON.parse(text) as ServerControl
                showdownInput.control(control)
                for (const listener of controls) {
                  listener(control)
                }
              },
            },
          }
        : undefined
    },
  }
  function publishEvents(): void {
    for (const event of world.events) {
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
  function settleDeposits(): void {
    for (const deposit of world.deposits) {
      if (deposit.playerId !== selfSlot || deposits.has(deposit.seq)) {
        continue
      }
      deposits.add(deposit.seq)
      banked = Math.min(PRACTICE_PURSE_CAP, banked + deposit.amount + deposit.commission)
      for (const listener of controls) {
        listener({
          type: 'deposit',
          seq: deposit.seq,
          amount: deposit.amount,
          commission: deposit.commission,
          banked,
          ok: true,
        })
      }
      patchRecord({ purse: banked, firstBank: true })
    }
    world.deposits.length = 0
  }
  simulation.step([])
  syncPoses(simulation)
  const presentation = new TickPresentation(simulation.physics.players, world, selfId)
  return {
    selfId,
    selfSlot,
    practice: true,
    lobbyId: 'loopback',
    subscribeControl(listener) {
      controls.add(listener)
      return () => controls.delete(listener)
    },
    control(text) {
      const message = JSON.parse(text) as {
        type: string
        on?: boolean
        showdownId?: number
        localMs?: number
      }
      if (message.type === 'showdown_shot') {
        judge.shot(message.showdownId ?? -1, selfSlot, message.localMs ?? null, performance.now())
      }
      if (message.type === 'practice_pause') {
        paused = message.on === true
      }
      if (message.type === 'practice_record') {
        rules = practiceOptions()
        applyPractice(world, bots, rules)
      }
    },
    world,
    players: presentation.poses,
    appearance: (id) =>
      id === selfId ? { loadout: DEFAULT_LOADOUT, dyes: {}, key: 'local-player' } : undefined,
    get banked() {
      return banked
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update(dt, input) {
      if (disposed || paused) {
        return
      }
      showdownInput.sample(input)
      elapsed = Math.min(0.2, elapsed + dt)
      while (elapsed >= 1 / SIMULATION_HZ) {
        presentation.capture()
        frames.fill(null)
        frames[selfSlot] = domainInput(input, seq++, world.tick)
        bots.frames(world, frames)
        stakeRespawns(world, rules)
        simulation.step(frames)
        judge.update(judgeHost, performance.now())
        syncPoses(simulation)
        publishEvents()
        settleDeposits()
        elapsed -= 1 / SIMULATION_HZ
      }
      presentation.present(elapsed * SIMULATION_HZ, input)
    },
    cameraTrace(from, to) {
      const hit = simulation.physics.app.systems.rigidbody?.raycastFirst(from, to, {
        filterCallback: (entity: Entity) => !simulation.physics.players.has(entity.name),
      })
      return hit ? new Vec3(hit.point.x, hit.point.y, hit.point.z) : null
    },
    dispose() {
      if (!disposed) {
        disposed = true
        listeners.clear()
        controls.clear()
        simulation.dispose()
      }
    },
  }
}
