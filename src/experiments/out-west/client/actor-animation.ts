/** Native masked animation selection; prediction and the SDK already own body transforms. */
import type { AnimComponentLayer } from 'playcanvas'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../contract/town.ts'
import type { DuelActor } from '../duel/native-actor.ts'
import { CROUCH_SPEED, RELOAD_TICKS, SPRINT_SPEED } from '../ffa/sim/constants.ts'
import type { Player } from '../ffa/sim/types.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import { DYNAMITE_THROW_SECONDS, RECOIL_SECONDS } from '../scene/native-animation-timing.ts'
import type { HeldWeapon } from './first-person-sights.ts'

export interface AnimatedRider {
  actor: DuelActor
  clip: string
  aim: AnimComponentLayer | undefined
  weaponLayer: AnimComponentLayer | undefined
  firingUntil: number
  firingWeapon?: HeldWeapon | undefined
  throwingUntil?: number
  reloadTicks?: number
}
export function heldWeapon(domain: Player | undefined): HeldWeapon {
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
const PICKUP_CLIP = /(?:Hold|Shoot)_(?:rifle|shotgun)$/u
const SHOT_CLIP = /(?:^|_)Shoot(?:_|$)/u
function firingClip(rider: AnimatedRider, crouched: boolean, first: boolean): string | undefined {
  const layer = rider.weaponLayer
  // Each shot keeps the stance in which it started. The local arms can finish
  // their native clip if the animation clock trails the event deadline.
  if (
    rider.firingUntil > 0 &&
    (first || performance.now() < rider.firingUntil) &&
    layer &&
    SHOT_CLIP.test(layer.activeState) &&
    layer.activeStateCurrentTime < layer.activeStateDuration
  ) {
    return layer.activeState
  }
  return performance.now() < rider.firingUntil ? rider.actor.shotClip(crouched) : undefined
}
export function displayedWeapon(
  rider: AnimatedRider,
  domain: Player | undefined,
  crouched: boolean,
  first: boolean,
): HeldWeapon {
  return rider.firingWeapon && firingClip(rider, crouched, first)
    ? rider.firingWeapon
    : heldWeapon(domain)
}
function upperClip(
  rider: AnimatedRider,
  domain: Player | undefined,
  crouched: boolean,
  first: boolean,
): string {
  if (performance.now() < (rider.throwingUntil ?? 0)) {
    return `${crouched ? 'Crouch_' : ''}Throw_Dynamite`
  }
  const shot = firingClip(rider, crouched, first)
  if (shot) {
    return shot
  }
  const weapon = heldWeapon(domain)
  if (weapon !== 'revolver') {
    return `${crouched ? 'Crouch_' : ''}Hold_${weapon}`
  }
  if ((domain?.reloadTicks ?? 0) > 0) {
    return crouched ? 'Crouch_Reload' : rider.actor.animation('Reload')
  }
  const layer = rider.weaponLayer
  if (domain?.alive && layer) {
    // Finish the last pickup recoil before drawing the sidearm. Another
    // accepted shot can interrupt the draw immediately.
    if (
      layer.activeState.startsWith('Draw') &&
      layer.activeStateCurrentTime < layer.activeStateDuration
    ) {
      return layer.activeState
    }
    if (PICKUP_CLIP.test(layer.activeState)) {
      const draw = rider.actor.animation('Draw')
      if (layer.states.includes(draw)) {
        return draw
      }
    }
  }
  return rider.actor.animation(crouched ? 'Crouch_Idle_Gun_Pointing' : 'Idle_Gun_Pointing')
}
function aimClip(player: PlayerState, domain: Player | undefined): string {
  const stance = (player.crouched ?? domain?.crouched ?? false) ? 'Crouch_' : ''
  return `${stance}${player.pitch >= 0 ? 'Aim_Up' : 'Aim_Down'}`
}
function transitionUpper(
  rider: AnimatedRider,
  layer: AnimComponentLayer,
  upper: string,
  reloadTicks: number,
): void {
  const changed = layer.activeState !== upper
  if (changed) {
    if (!layer.states.includes(upper)) {
      return
    }
    const throwTime =
      upper.endsWith('Throw_Dynamite') && layer.activeState.endsWith('Throw_Dynamite')
        ? layer.activeStateCurrentTime
        : undefined
    if (upper.startsWith('Draw')) {
      rider.actor.drawWeapon()
    }
    layer.transition(upper, 0.05)
    if (throwTime !== undefined) {
      layer.activeStateCurrentTime = throwTime
    }
  }
  if (upper.includes('Reload') && (changed || reloadTicks !== rider.reloadTicks)) {
    // Catch up after a late snapshot, appearance load, or stance change.
    // Between snapshots the native clip runs freely at the simulation rate.
    const tick = layer.activeStateDuration / RELOAD_TICKS
    const elapsed = (RELOAD_TICKS - Math.min(RELOAD_TICKS, reloadTicks)) * tick
    if (changed || Math.abs(elapsed - layer.activeStateCurrentTime) > 2 * tick) {
      layer.activeStateCurrentTime = elapsed
    }
  }
  rider.reloadTicks = reloadTicks
}
function transitionGait(
  rider: AnimatedRider,
  locomotion: string,
  clip: string,
  speed: number,
): void {
  const { actor } = rider
  if (clip === rider.clip) {
    return
  }
  // The eight directions of each stride share their contact phases. Starting a
  // fresh cycle on each direction change makes a circling rider step twice.
  const redirect = clip.startsWith('Stride_') && rider.clip.startsWith(`Stride_${locomotion}_`)
  const lower = redirect ? actor.model.anim?.baseLayer : undefined
  const phase =
    lower?.activeState === rider.clip && lower.activeStateDuration > 0
      ? (lower.activeStateCurrentTime / lower.activeStateDuration) % 1
      : undefined
  actor.play(clip, speed < 0.1 ? 0.04 : 0.1)
  if (phase !== undefined && lower) {
    lower.activeStateCurrentTime = phase * lower.activeStateDuration
  }
  rider.clip = clip
}
export function animateRider(
  rider: AnimatedRider,
  player: PlayerState,
  options: { first: boolean; domain: Player | undefined },
): void {
  const alive = player.hp > 0
  if (!alive) {
    rider.firingUntil = 0
    rider.throwingUntil = 0
  }
  const throwing = performance.now() < (rider.throwingUntil ?? 0)
  const { actor } = rider
  const speed = Math.hypot(player.vx, player.vz)
  if (rider.aim) {
    const pose = aimClip(player, options.domain)
    if (rider.aim.activeState !== pose) {
      rider.aim.play(pose)
    }
    const weight =
      !options.first && alive && !throwing ? Math.min(1, Math.abs(player.pitch) / 1.45) : 0
    if (rider.aim.weight !== weight) {
      rider.aim.weight = weight
    }
  }
  const crouched = player.crouched ?? options.domain?.crouched ?? false
  // First-person movement comes from the viewmodel springs. Driving its authored
  // hips with world strides as well pulls the arms away from the camera on turns.
  const idle = crouched ? 'Crouch_Idle' : 'Idle'
  const locomotion =
    options.first && alive && !throwing ? idle : gait(player, options.domain, speed)
  const clip = directionClip(actor, player, locomotion)
  if (rider.weaponLayer) {
    const upper = upperClip(rider, options.domain, crouched, options.first)
    const weight = alive ? 1 : 0
    if (rider.weaponLayer.weight !== weight) {
      rider.weaponLayer.weight = weight
    }
    transitionUpper(rider, rider.weaponLayer, upper, options.domain?.reloadTicks ?? 0)
  }
  transitionGait(rider, locomotion, clip, speed)
  const authored = actor.gaitSpeeds[locomotion] ?? GAIT_SPEED.get(locomotion) ?? actor.walkSpeed
  actor.speed(GAITS.has(locomotion) ? speed / authored : 1)
}

/** Retain the fired weapon through recoil if its last round emptied the pickup. */
export function beginRecoil(rider: AnimatedRider, weapon?: HeldWeapon): void {
  rider.throwingUntil = 0
  rider.firingUntil = performance.now() + RECOIL_SECONDS * 1000
  rider.firingWeapon = weapon
  rider.actor.weaponsVisible(true)
  if (weapon) {
    rider.actor.hold(weapon, true)
  }
  rider.actor.fireWeapon()
}

/** Accepted events start one native toss; locomotion keeps its independent clock. */
export function beginDynamiteThrow(
  rider: AnimatedRider,
  player: PlayerState,
  until = performance.now() + DYNAMITE_THROW_SECONDS * 1000,
): void {
  if (player.hp <= 0) {
    return
  }
  const clip = `${player.crouched ? 'Crouch_' : ''}Throw_Dynamite`
  if (!rider.weaponLayer?.states.includes(clip)) {
    return
  }
  rider.firingUntil = 0
  rider.throwingUntil = until
  rider.actor.weaponsVisible(false)
  if (rider.aim) {
    rider.aim.weight = 0
  }
  rider.weaponLayer.transition(clip, 0.035)
}

/** A local arms presentation follows the physical rider's accepted action deadline. */
export function syncDynamiteThrow(rider: AnimatedRider, player: PlayerState, until: number): void {
  const now = performance.now()
  const deadline = player.hp > 0 && until > now ? until : 0
  if (deadline !== (rider.throwingUntil ?? 0)) {
    rider.throwingUntil = 0
    if (deadline > 0) {
      beginDynamiteThrow(rider, player, deadline)
      if (rider.weaponLayer && rider.throwingUntil === deadline) {
        rider.weaponLayer.activeStateCurrentTime = Math.max(
          0,
          DYNAMITE_THROW_SECONDS - (deadline - now) / 1000,
        )
      }
    }
  }
  rider.actor.weaponsVisible(deadline === 0)
}
