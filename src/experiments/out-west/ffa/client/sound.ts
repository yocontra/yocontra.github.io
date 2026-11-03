/**
 * Frontier's soundscape outside the event stream: the town's tune and its time-of-day bed, the
 * saloon spilling chatter and piano into the street, and footsteps (yours and the nearest few
 * players'), on boardwalk wood or street dirt, with a spur jingle when the loadout has spurs.
 */
import type { AudioEngine, Loop } from '../../audio/audio.ts'
import { ANIM_RUN, EF_ALIVE } from '../../contract/town.ts'
import type { RemoteView } from './interp.ts'
import { onBoardwalk, saloonSpots } from './surface.ts'

/** Metres between footfalls at a run (5.5 m/s at about three steps a second). */
const STRIDE = 1.7
/** A jump this far in one frame is a respawn or a correction, not a step. */
const TELEPORT = 3
/** Only players this close are heard walking, and only the nearest few. */
const STEP_RADIUS = 16
const STEP_VOICES = 4
/** Other players' steps never come closer together than this, s (a crowd is a patter, not a roll). */
const REMOTE_STEP_GAP = 0.07

interface Gait {
  x: number
  z: number
  /** Metres since the last footfall. */
  d: number
  /** Footfalls so far (spurs ring on every other one). */
  n: number
  seen: number
}

export class FrontierSound {
  private readonly audio: AudioEngine
  private readonly gaits = new Map<number, Gait>()
  private saloon: Loop | null = null
  private piano: Loop | null = null
  private started = false as boolean
  private frame = 0
  private lastRemoteStep = 0
  private readonly near: RemoteView[] = []

  constructor(audio: AudioEngine) {
    this.audio = audio
  }

  /** On the first gesture: the town's tune, the late-afternoon bed and the saloon. */
  start(day: number): void {
    const a = this.audio
    if (this.started || !a.ready) {
      return
    }
    this.started = true
    a.playSong('frontier')
    a.musicLevel(0, 0.4)
    a.musicLowpass(18_000, 0.1)
    a.setTimeOfDay(day)
    const spots = saloonSpots()
    if (spots) {
      this.saloon = a.loop('saloon', 0.9, 'amb', spots.door)
      this.piano = a.loop('saloonPiano', 0.7, 'amb', spots.room)
    }
  }

  /**
   * One frame of footsteps. `own` is your render position and whether you are walking; `remotes`
   * are the other players this frame; `spurs(id)` says whether that player wears spurs.
   */
  steps(
    own: { id: number; x: number; z: number; moving: boolean },
    remotes: readonly RemoteView[],
    spurs: (id: number) => boolean,
    nowS: number,
  ): void {
    if (!this.audio.ready) {
      return
    }
    this.frame++
    if (this.stride(own.id, own.x, own.z, own.moving)) {
      const g = this.gaits.get(own.id)
      this.audio.footstep(onBoardwalk(own.x, own.z) ? 'wood' : 'dirt', {
        gain: 0.45,
        spurs: spurs(own.id) && (g?.n ?? 0) % 2 === 0,
      })
    }
    const near = this.near
    near.length = 0
    for (const r of remotes) {
      const d = Math.hypot(r.x - own.x, r.z - own.z)
      if (r.ready && r.flags & EF_ALIVE && d < STEP_RADIUS) {
        near.push(r)
      }
    }
    near.sort((p, q) => Math.hypot(p.x - own.x, p.z - own.z) - Math.hypot(q.x - own.x, q.z - own.z))
    for (const [i, r] of near.entries()) {
      const walking = i < STEP_VOICES && r.anim === ANIM_RUN
      if (this.stride(r.id, r.x, r.z, walking) && nowS - this.lastRemoteStep >= REMOTE_STEP_GAP) {
        this.lastRemoteStep = nowS
        const g = this.gaits.get(r.id)
        this.audio.footstep(onBoardwalk(r.x, r.z) ? 'wood' : 'dirt', {
          pos: { x: r.x, y: 0.1, z: r.z },
          gain: 0.8,
          spurs: spurs(r.id) && (g?.n ?? 0) % 2 === 0,
        })
      }
    }
    // forget anyone out of earshot (their gait restarts when they come back)
    for (const [id, g] of this.gaits) {
      if (g.seen !== this.frame) {
        this.gaits.delete(id)
      }
    }
  }

  /** Track a player's gait; true when a foot lands this frame. */
  private stride(id: number, x: number, z: number, moving: boolean): boolean {
    const g = this.gaits.get(id)
    if (!g) {
      this.gaits.set(id, { x, z, d: 0, n: 0, seen: this.frame })
      return false
    }
    const moved = Math.hypot(x - g.x, z - g.z)
    g.x = x
    g.z = z
    g.seen = this.frame
    if (!moving || moved > TELEPORT) {
      // the next step lands half a stride after setting off
      g.d = STRIDE / 2
      return false
    }
    g.d += moved
    if (g.d < STRIDE) {
      return false
    }
    g.d = Math.min(g.d - STRIDE, STRIDE / 2)
    g.n++
    return true
  }

  dispose(): void {
    this.saloon?.stop()
    this.piano?.stop()
    this.saloon = null
    this.piano = null
    this.audio.stopAmbience()
    this.gaits.clear()
  }
}

/** Does this roster loadout wear spurs? */
export function wearsSpurs(loadout: readonly string[] | undefined): boolean {
  return loadout?.some((id) => id.startsWith('spurs.')) ?? false
}
