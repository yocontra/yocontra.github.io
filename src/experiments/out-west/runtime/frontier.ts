import { ANGLE_SCALE } from '../contract/town.ts'
import { activePlayers, createWorld, type WorldOptions } from '../ffa/sim/state.ts'
import type { InputFrame, Player } from '../ffa/sim/types.ts'
import { step as stepDomain } from '../ffa/sim/world.ts'
import { newMotion } from './abilities.ts'
import type { CollisionData, PlayerInput } from './protocol.ts'
import { bindWindowContacts } from './window-contact.ts'
import { createSimulation, type Simulation } from './world.ts'

/** Frontier product rules over native PlayCanvas movement. No renderer dependency. */
export function createFrontierSimulation(
  options: WorldOptions & { ammo: unknown; collision: CollisionData },
) {
  const world = createWorld(options)
  const physics = createSimulation(options)
  const generations = new Map<string, number>()
  const windowEligible = new Set<string>()
  const releaseWindows = bindWindowContacts({ world, physics, eligible: windowEligible })
  world.castWorld = physics.castWorld
  world.movePlayers = (frames) => {
    windowEligible.clear()
    const inputs = new Map<string, PlayerInput>()
    const present = new Set<string>()
    for (const player of activePlayers(world)) {
      const id = String(player.id)
      present.add(id)
      const before = physics.players.get(id)
      const continuous =
        before &&
        Math.hypot(before.x - player.x, before.y - 0.9 - player.y, before.z - player.z) < 0.05
      const reset = syncBody(physics, player, generations.get(id) !== player.spawnTick)
      if (player.alive && continuous && !reset) {
        windowEligible.add(id)
      }
      generations.set(id, player.spawnTick)
      inputs.set(id, toInput(player, frames[player.id]))
    }
    for (const id of physics.players.keys()) {
      if (!present.has(id)) {
        physics.removePlayer(id)
        generations.delete(id)
      }
    }
    physics.step(inputs)
    for (const player of activePlayers(world)) {
      const pose = physics.players.get(String(player.id))
      if (!pose) {
        continue
      }
      applyPose(player, pose)
    }
  }
  return {
    world,
    physics,
    step: (frames: readonly (InputFrame | null | undefined)[]) => {
      stepDomain(world, frames)
      // A respawn lands after this tick's movement; move its body now, not a tick later.
      for (const player of activePlayers(world)) {
        const id = String(player.id)
        if (generations.has(id) && generations.get(id) !== player.spawnTick) {
          syncBody(physics, player, true)
          generations.set(id, player.spawnTick)
        }
      }
    },
    dispose: () => {
      windowEligible.clear()
      releaseWindows()
      generations.clear()
      physics.dispose()
    },
  }
}

function syncBody(physics: Simulation, player: Player, generationChanged: boolean) {
  const id = String(player.id)
  const body =
    physics.players.get(id) ?? physics.addPlayer(id, [player.x, player.y + 0.9, player.z])
  const reset =
    generationChanged ||
    Math.hypot(body.x - player.x, body.z - player.z) > 2 ||
    Math.abs(body.y - 0.9 - player.y) > 2
  if (reset) {
    physics.adopt(id, {
      ...body,
      x: player.x,
      y: player.y + 0.9,
      z: player.z,
      vx: 0,
      vy: 0,
      vz: 0,
      hp: player.hp,
      ammo: player.ammo,
      lastButtons: player.lastButtons,
      motion: newMotion(player.x, player.y, player.z),
    })
  }
  return reset
}
function toInput(player: Player, frame: InputFrame | null | undefined): PlayerInput {
  const movable = player.alive && player.showdown < 0 && player.lingerUntil < 0
  const {
    seq = player.lastSeq,
    moveX = 0,
    moveZ = 0,
    aim = player.aim,
    pitch = 0,
    buttons = 0,
  } = frame ?? {}
  return {
    seq,
    moveX: movable ? moveX / 127 : 0,
    moveZ: movable ? moveZ / 127 : 0,
    yaw: (-aim / ANGLE_SCALE) * Math.PI * 2 - Math.PI / 2,
    pitch: ((pitch / 127) * Math.PI) / 2,
    buttons: movable ? buttons : 0,
  }
}
function applyPose(player: Player, pose: import('./protocol.ts').PlayerState) {
  if (pose.motion) {
    Object.assign(player, pose.motion)
  }
  player.x = pose.x
  player.y = pose.y - 0.9
  player.z = pose.z
  player.vy = pose.vy
  player.grounded = pose.grounded
  player.crouched = pose.crouched ?? player.crouched
  player.moving = Math.hypot(pose.vx, pose.vz) > 0.1
}
