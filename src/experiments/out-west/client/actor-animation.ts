/** Native masked animation selection; prediction and the SDK already own body transforms. */
import type { AnimComponentLayer } from 'playcanvas'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../contract/town.ts'
import type { DuelActor } from '../duel/native-actor.ts'
import { CROUCH_SPEED, SPRINT_SPEED } from '../ffa/sim/constants.ts'
import type { Player } from '../ffa/sim/types.ts'
import type { PlayerState } from '../runtime/protocol.ts'

interface AnimatedRider {
  actor: DuelActor
  clip: string
  aim: AnimComponentLayer | undefined
  weaponLayer: AnimComponentLayer | undefined
  firingUntil: number
}
export function heldWeapon(domain: Player | undefined): 'rifle' | 'shotgun' | 'revolver' {
  if (domain?.weapon === WEAPON_RIFLE) {
    return 'rifle'
  }
  if (domain?.weapon === WEAPON_SHOTGUN) {
    return 'shotgun'
  }
  return 'revolver'
}
/** Near the geometric mean of the authored walk and run strides, so neither clip plays far off its cadence. */
const WALK_TO_RUN = 2.2
/** Remote poses carry no motor ticks; only slides and rolls exceed these speeds. */
const SLIDE_GAIT = CROUCH_SPEED * 1.3
const ROLL_GAIT = SPRINT_SPEED * 1.2
export function gait(player: PlayerState, domain: Player | undefined, speed: number): string {
  if (player.hp <= 0) {
    return 'Death'
  }
  if (!player.grounded) {
    return 'Jump_Loop'
  }
  const crouched = player.crouched ?? domain?.crouched ?? false
  const committed = (player.motion?.slideTicks ?? 0) > 0 || (player.motion?.rollTicks ?? 0) > 0
  if (committed || speed > ROLL_GAIT || (crouched && speed > SLIDE_GAIT)) {
    return 'Crouch_Idle'
  }
  if (crouched) {
    return speed > 0.1 ? 'Crouch_Walk' : 'Crouch_Idle'
  }
  if (speed > 6) {
    return 'Sprint'
  }
  if (speed > WALK_TO_RUN) {
    return 'Run'
  }
  return speed > 0.1 ? 'Walk' : 'Idle'
}
const GAITS = new Set(['Walk', 'Run', 'Sprint', 'Crouch_Walk'])
const GAIT_SPEED = new Map([
  ['Walk', 0.94],
  ['Run', 5.66],
  ['Sprint', 8.42],
  ['Crouch_Walk', 0.69],
])
function directionClip(actor: DuelActor, player: PlayerState, name: string): string {
  if (!GAITS.has(name)) {
    return name
  }
  const forward = -(player.vx * Math.sin(player.yaw) + player.vz * Math.cos(player.yaw))
  const right = player.vx * Math.cos(player.yaw) - player.vz * Math.sin(player.yaw)
  const direction = (Math.round((-Math.atan2(right, forward) * 4) / Math.PI) + 8) % 8
  const stride = `Stride_${name}_${direction}`
  return actor.hasAnimation(stride) ? stride : name
}
function upperClip(rider: AnimatedRider, domain: Player | undefined, crouched: boolean): string {
  if (performance.now() < rider.firingUntil) {
    return rider.actor.shotClip(crouched)
  }
  const weapon = heldWeapon(domain)
  if (weapon !== 'revolver') {
    return `${crouched ? 'Crouch_' : ''}Hold_${weapon}`
  }
  if ((domain?.reloadTicks ?? 0) > 0) {
    return crouched ? 'Crouch_Reload' : rider.actor.animation('Reload')
  }
  return crouched ? 'Crouch_Idle_Gun_Pointing' : rider.actor.animation('Idle_Gun_Pointing')
}
function aimClip(player: PlayerState, domain: Player | undefined): string {
  const stance = (player.crouched ?? domain?.crouched ?? false) ? 'Crouch_' : ''
  return `${stance}${player.pitch >= 0 ? 'Aim_Up' : 'Aim_Down'}`
}
export function animateRider(
  rider: AnimatedRider,
  player: PlayerState,
  options: { first: boolean; domain: Player | undefined },
): void {
  const { actor } = rider
  const speed = Math.hypot(player.vx, player.vz)
  if (rider.aim) {
    const pose = aimClip(player, options.domain)
    if (rider.aim.activeState !== pose) {
      rider.aim.play(pose)
    }
    const weight = !options.first && player.hp > 0 ? Math.min(1, Math.abs(player.pitch) / 1.45) : 0
    if (rider.aim.weight !== weight) {
      rider.aim.weight = weight
    }
  }
  const locomotion = gait(player, options.domain, speed)
  const clip = directionClip(actor, player, locomotion)
  if (rider.weaponLayer) {
    const upper = upperClip(
      rider,
      options.domain,
      player.crouched ?? options.domain?.crouched ?? false,
    )
    const weight = player.hp > 0 ? 1 : 0
    if (rider.weaponLayer.weight !== weight) {
      rider.weaponLayer.weight = weight
    }
    if (rider.weaponLayer.activeState !== upper && rider.weaponLayer.states.includes(upper)) {
      rider.weaponLayer.transition(upper, 0.05)
    }
  }
  if (clip !== rider.clip) {
    actor.play(clip, speed < 0.1 ? 0.04 : 0.1)
    rider.clip = clip
  }
  const authored = actor.gaitSpeeds[locomotion] ?? GAIT_SPEED.get(locomotion) ?? actor.walkSpeed
  actor.speed(GAITS.has(locomotion) ? speed / authored : 1)
}
