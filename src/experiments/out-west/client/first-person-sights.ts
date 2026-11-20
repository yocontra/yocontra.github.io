/** First-person sight presentation: one eased amount per life/weapon; the shot ray never moves. */
import { math, Quat, Vec3 } from 'playcanvas'
import type { Player } from '../ffa/sim/types.ts'
import { Buttons, type PlayerInput } from '../runtime/protocol.ts'

export type HeldWeapon = 'revolver' | 'rifle' | 'shotgun'
// Bring the authored hip poses in toward the view axis and lift the revolver's low bore.
const REVOLVER_HIP = new Quat().setFromEulerAngles(-8, 184, 0)
const LONG_GUN_HIP = new Quat().setFromEulerAngles(-1.5, 185.5, 0)
export function hipRotationFor(held: HeldWeapon): Quat {
  return held === 'revolver' ? REVOLVER_HIP : LONG_GUN_HIP
}
export interface SightProfile {
  /** Front blade/bead and rear notch/rib in `socket.muzzle` space (+X along the bore, +Y up). */
  readonly front: Vec3
  readonly rear: Vec3
  /** Eye-to-rear-landmark distance once the sights are aligned. */
  readonly relief: number
  /** Viewmodel cant in degrees about the aligned sight line. */
  readonly roll?: number
  /** World lens zoom while aimed; the viewmodel keeps its own projection. */
  readonly zoom: number
  readonly enter: number
  readonly exit: number
}
// Measured from the native gun meshes: every revolver shares one frame (blade 16 mm, hammer spur
// 23 mm above the bore), so the line clears the spur; long guns sight over their blade/bead.
export const SIGHTS: ReadonlyMap<HeldWeapon, SightProfile> = new Map([
  [
    'revolver',
    {
      front: new Vec3(-0.01, 0.0168, 0),
      rear: new Vec3(-0.255, 0.0265, 0),
      relief: 0.42,
      zoom: 0.86,
      enter: 0.15,
      exit: 0.11,
    },
  ],
  [
    'rifle',
    {
      front: new Vec3(-0.015, 0.0268, 0),
      rear: new Vec3(-0.43, 0.0258, 0),
      relief: 0.83,
      zoom: 0.72,
      enter: 0.22,
      exit: 0.14,
    },
  ],
  [
    'shotgun',
    {
      front: new Vec3(-0.01, 0.0228, 0),
      rear: new Vec3(-0.67, 0.0292, 0),
      relief: 0.86,
      roll: -2,
      zoom: 0.84,
      enter: 0.2,
      exit: 0.13,
    },
  ],
])

/** The held weapon and its eased sight amount for this frame. */
export interface Sight {
  held: HeldWeapon
  amount: number
}
export const RESTING_SIGHT: Sight = { held: 'revolver', amount: 0 }
export interface SightState {
  progress: number
  life: number | undefined
  weapon: HeldWeapon | undefined
}
export const sightState = (): SightState => ({ progress: 0, life: undefined, weapon: undefined })
interface SightInput {
  /** First person, playing and input enabled. */
  active: boolean
  /** The local arms are presented with the held weapon and its sight landmarks. */
  ready: boolean
  intent: Pick<PlayerInput, 'buttons'>
  held: HeldWeapon
  player: Pick<Player, 'alive' | 'spawnTick' | 'reloadTicks' | 'sprinting'> | null | undefined
}

/** Steps the eased sight amount from the viewport's existing engine update. */
export function advanceSights(state: SightState, input: SightInput, dt: number): number {
  const { player } = input
  const changed = state.life !== player?.spawnTick || state.weapon !== input.held
  state.life = player?.spawnTick
  state.weapon = input.held
  const profile = SIGHTS.get(input.held)
  if (!(input.active && input.ready && player?.alive && profile) || changed) {
    state.progress = 0
    return 0
  }
  const aiming =
    Boolean(input.intent.buttons & Buttons.aim) && player.reloadTicks === 0 && !player.sprinting
  const step = Math.max(0, Math.min(dt, 0.1)) / (aiming ? profile.enter : profile.exit)
  state.progress = math.clamp(state.progress + (aiming ? step : -step), 0, 1)
  return math.smoothstep(0, 1, state.progress)
}

/** The world lens narrows while aimed; the default first-person lens is unchanged otherwise. */
export function sightFov(fov: number, sight: Sight): number {
  return math.lerp(fov, fov * (SIGHTS.get(sight.held)?.zoom ?? 1), sight.amount)
}

// Project the arms on the shorter screen axis. Portrait needs more room for the sleeves.
const HIP_FOV = { landscape: 58, portrait: 68 }
const REVOLVER_FOV = { landscape: 50, portrait: 58 }
const LONG_GUN_FOV = { landscape: 56, portrait: 64 }

export function viewmodelScale(
  worldFov: number,
  aspect: number,
  held: HeldWeapon,
  sight: number,
): number {
  const shape = aspect < 1 ? 'portrait' : 'landscape'
  const aimedFov = held === 'revolver' ? REVOLVER_FOV : LONG_GUN_FOV
  const modelFov = math.lerp(HIP_FOV[shape], aimedFov[shape], sight)
  const worldTan = Math.tan((worldFov * math.DEG_TO_RAD) / 2) * Math.min(1, aspect)
  return worldTan / Math.tan((modelFov * math.DEG_TO_RAD) / 2)
}
