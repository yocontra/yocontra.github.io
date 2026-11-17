import { type GraphNode, Vec3 } from 'playcanvas'
import {
  DYNAMITE_RELEASE_SECONDS,
  DYNAMITE_THROW_SECONDS,
} from '../scene/native-animation-timing.ts'

/** A visual arc only. The server alone owns the endpoint, fuse and blast. */
export class DynamiteFlight {
  readonly position = new Vec3()
  private readonly release = new Vec3()
  private released = false as boolean
  readonly by: number
  readonly target: Vec3
  private readonly started: number
  private readonly hand: () => GraphNode | null
  constructor(options: {
    by: number
    target: Vec3
    started: number
    hand: () => GraphNode | null
    origin: Vec3
  }) {
    this.by = options.by
    this.target = options.target.clone()
    this.started = options.started
    this.hand = options.hand
    this.release.copy(options.origin)
    this.position.copy(options.origin)
  }

  sample(now: number): { held: boolean; progress: number; done: boolean } {
    const seconds = Math.max(0, (now - this.started) / 1000)
    if (!this.released) {
      const hand = this.hand()
      if (hand) {
        this.release.copy(hand.getPosition())
      }
      this.released = seconds >= DYNAMITE_RELEASE_SECONDS
    }
    const progress = Math.max(
      0,
      Math.min(
        1,
        (seconds - DYNAMITE_RELEASE_SECONDS) / (DYNAMITE_THROW_SECONDS - DYNAMITE_RELEASE_SECONDS),
      ),
    )
    this.position.lerp(this.release, this.target, progress)
    const distance = this.release.distance(this.target)
    this.position.y += 4 * Math.min(1.4, distance * 0.12) * progress * (1 - progress)
    if (progress === 1) {
      this.position.copy(this.target)
    }
    return { held: !this.released, progress, done: seconds >= DYNAMITE_THROW_SECONDS }
  }
}
