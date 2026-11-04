/**
 * Every key and button in the Frontier, in one place (the How to play card reads the same table).
 *
 * Over the shoulder and first person (the default), CoD style: WASD moves relative to where you
 * look, the mouse looks (pointer lock), LMB fires, RMB aims down the sights (hold, or a toggle in
 * the settings; from the holster it also closes the Dead-Eye reticle), Shift sprints, C crouches
 * (mid-sprint: a slide), Ctrl crouches while held, Space jumps or vaults, R reloads, E banks /
 * opens / accepts, Q calls out, G throws dynamite, V swaps first and third person, X swaps the
 * shoulder, Tab holds the scoreboard, Esc pauses.
 *
 * Top-down (kept as an option): the same keys, but the mouse aims at the ground.
 */
import {
  BTN_CALLOUT,
  BTN_CROUCH,
  BTN_INTERACT,
  BTN_JUMP,
  BTN_RELOAD,
  BTN_ROLL,
  BTN_SPRINT,
  BTN_THROW,
} from '../../contract/town.ts'

/** Jump / vault (the sim's `BTN_JUMP`): Space, gamepad A, the touch JUMP button. */
export const JUMP_BIT = BTN_JUMP
/**
 * Local-only bits (never sent; `stance.ts` turns them into `BTN_CROUCH`): a tap of crouch, which
 * toggles the crouch or, mid-sprint, slides.
 */
export const CROUCH_TAP = 0x80_00
export const LOCAL_BITS = CROUCH_TAP

/** Shooter views: held keys → input buttons. */
export const SHOOTER_KEYS: Readonly<Record<string, number>> = {
  Space: JUMP_BIT,
  ShiftLeft: BTN_SPRINT,
  ShiftRight: BTN_SPRINT,
  KeyC: CROUCH_TAP,
  ControlLeft: BTN_CROUCH,
  KeyR: BTN_RELOAD,
  KeyE: BTN_INTERACT,
  KeyF: BTN_INTERACT,
  KeyQ: BTN_CALLOUT,
  KeyG: BTN_THROW,
}

/** Top-down view: the original map. */
export const TOP_KEYS: Readonly<Record<string, number>> = {
  Space: BTN_JUMP,
  ShiftLeft: BTN_ROLL,
  ShiftRight: BTN_ROLL,
  KeyC: BTN_ROLL,
  KeyR: BTN_RELOAD,
  KeyE: BTN_INTERACT,
  KeyF: BTN_INTERACT,
  KeyQ: BTN_CALLOUT,
  KeyG: BTN_THROW,
}

/** View keys (not sent to the server). */
export const KEY_VIEW_TOGGLE = 'KeyV'
export const KEY_SHOULDER = 'KeyX'
export const KEY_SCOREBOARD = 'Tab'

/** The How to play rows, desktop: [keys, what they do]. */
export const DESKTOP_HELP: readonly (readonly [string, string])[] = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['Left click', 'Shoot'],
  ['Right click', 'Aim down the sights'],
  ['Shift', 'Sprint (no shooting)'],
  ['C / Ctrl', 'Crouch; slide while sprinting'],
  ['Space', 'Jump / vault'],
  ['R', 'Reload'],
  ['E', 'Bank, open, accept'],
  ['Q', 'Call out a rider'],
  ['V', 'First / third person'],
  ['X', 'Swap shoulder'],
  ['Tab', 'Scoreboard'],
  ['Esc', 'Pause and settings'],
]

/** The How to play rows, touch. */
export const TOUCH_HELP: readonly (readonly [string, string])[] = [
  ['Left thumb', 'Move'],
  ['Right thumb', 'Drag to look'],
  ['FIRE', 'Tap to shoot, hold to keep firing'],
  ['AIM', 'Aim down the sights'],
  ['Stick past the ring', 'Sprint'],
  ['CROUCH', 'Crouch; slide while sprinting'],
  ['JUMP', 'Jump / vault'],
  ['RELOAD', 'Reload'],
  ['BANK', 'Shows at a bank window'],
]
