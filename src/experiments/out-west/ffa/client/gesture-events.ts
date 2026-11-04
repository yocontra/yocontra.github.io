/**
 * Events that make a rider gesture (scene/gestures.ts): the throw, stooping for a bag or a map
 * pickup, the call-out, the nod at the bank window, and the gun coming up on a respawn.
 */
import {
  EV_BAG_GONE,
  EV_CALLOUT,
  EV_DEPOSIT,
  EV_DYNAMITE_THROWN,
  EV_PICKUP_TAKEN,
  EV_RESPAWN,
  NONE,
} from '../../contract/town.ts'
import type { Crowd } from '../scene/crowd.ts'
import type { WireEvent } from '../sim/codec-events.ts'

export function gestureFor(crowd: Crowd, ev: WireEvent): void {
  switch (ev.type) {
    case EV_DYNAMITE_THROWN:
      crowd.gesture(ev.player, 'throw')
      break
    case EV_PICKUP_TAKEN:
      if (ev.player !== NONE) {
        crowd.gesture(ev.player, 'pickup')
      }
      break
    case EV_BAG_GONE:
      if (ev.by !== NONE) {
        crowd.gesture(ev.by, 'pickup')
      }
      break
    case EV_CALLOUT:
      crowd.gesture(ev.challenger, 'callout')
      break
    case EV_DEPOSIT:
      crowd.gesture(ev.player, 'bank')
      break
    case EV_RESPAWN:
      crowd.gesture(ev.player, 'draw')
      break
    default:
      break
  }
}
