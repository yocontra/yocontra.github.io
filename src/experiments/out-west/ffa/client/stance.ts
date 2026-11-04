// biome-ignore-all lint/suspicious/noUnnecessaryConditions: the toggle flips inside apply(); Biome narrows it to the branch above
/**
 * Crouch and slide, CoD style, on top of the held-button word the devices produce: a tap of
 * crouch (C, gamepad B, the touch CROUCH button: `CROUCH_TAP`, never sent) toggles the crouch,
 * or mid-sprint starts a slide (`BTN_CROUCH` is held for the slide, then let go, so you come out
 * of it on your feet); Ctrl held crouches while held. Jumping or sprinting stands you up.
 */
import { BTN_CROUCH, BTN_JUMP, BTN_SPRINT } from '../../contract/town.ts'
import { SLIDE_TICKS } from '../sim/constants.ts'
import { CROUCH_TAP, LOCAL_BITS } from './bindings.ts'

export class Stance {
  /** The crouch toggle. */
  crouched = false
  /** Ticks left to hold `BTN_CROUCH` for a slide. */
  private slideHold = 0
  private prev = 0

  /**
   * One input tick: the devices' buttons in (local bits included), the wire's buttons out.
   * `sprinting` is the predicted sprint state of the last tick.
   */
  apply(buttons: number, sprinting: boolean, alive: boolean): number {
    const rising = buttons & ~this.prev
    this.prev = buttons
    let out = buttons & ~LOCAL_BITS
    if (!alive) {
      this.crouched = false
      this.slideHold = 0
      return out & ~BTN_CROUCH
    }
    if (rising & CROUCH_TAP) {
      if (sprinting) {
        // a slide; the press edge rides in on this tick's BTN_CROUCH
        this.slideHold = SLIDE_TICKS
        this.crouched = false
      } else {
        this.crouched = !this.crouched
      }
    }
    if (rising & (BTN_JUMP | BTN_SPRINT)) {
      this.crouched = false
    }
    if (this.slideHold > 0) {
      this.slideHold--
      out |= BTN_CROUCH
      // no sprint request while sliding, or the slide's end would snap straight back to a sprint
      out &= ~BTN_SPRINT
    } else if (this.crouched) {
      out |= BTN_CROUCH
      out &= ~BTN_SPRINT
    }
    return out
  }

  reset(): void {
    this.crouched = false
    this.slideHold = 0
  }
}
