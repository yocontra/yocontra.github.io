/** First-person sight presentation: one eased amount per life/weapon; the shot ray never moves. */
import { math, Vec3 } from 'playcanvas'
import type { Player } from '../ffa/sim/types.ts'
import { Buttons, type PlayerInput } from '../runtime/protocol.ts'

export type HeldWeapon = 'revolver' | 'rifle' | 'shotgun'
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
      relief: 0.62,
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
      relief: 0.52,
      roll: -8,
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
  weapon: number | undefined
}
export const sightState = (): SightState => ({ progress: 0, life: undefined, weapon: undefined })
interface SightInput {
  /** First person, playing and input enabled. */
  active: boolean
  /** The local arms are presented with the held weapon and its sight landmarks. */
  ready: boolean
  intent: Pick<PlayerInput, 'buttons'>
  held: HeldWeapon
  player:
    | Pick<Player, 'alive' | 'spawnTick' | 'weapon' | 'reloadTicks' | 'sprinting'>
    | null
    | undefined
}

/** Steps the eased sight amount from the viewport's existing engine update. */
export function advanceSights(state: SightState, input: SightInput, dt: number): number {
  const { player } = input
  const changed = state.life !== player?.spawnTick || state.weapon !== player?.weapon
  state.life = player?.spawnTick
  state.weapon = player?.weapon
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
