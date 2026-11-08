import { Clock } from '@colyseus/core'
/** DO timer callbacks advance logical time even when the host wall clock is frozen. */
export class FixedRoomClock extends Clock {
  constructor() {
    super()
    this.now = () => Math.max(Date.now(), this.currentTime + 50)
  }
}
