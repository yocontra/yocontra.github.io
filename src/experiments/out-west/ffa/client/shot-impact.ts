/** Client-only killing-shot context; it never changes authoritative damage or movement. */
import {
  EV_KILL,
  EV_SHOT,
  SHOT_HIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import { shotCoord, type WireEvent } from '../sim/codec-events.ts'
import { MAX_PLAYERS } from '../sim/constants.ts'
import type { ShotPoint } from '../sim/types.ts'

export interface RagdollImpact {
  point: ShotPoint
  direction: ShotPoint
  weapon: typeof WEAPON_REVOLVER | typeof WEAPON_RIFLE | typeof WEAPON_SHOTGUN
}

interface RetainedImpact {
  impact: RagdollImpact
  killer: number
  tick: number
  atMs: number
}

const MAX_AGE_MS = 500

export class ShotImpacts {
  private readonly hits = new Map<number, RetainedImpact>()

  clear(): void {
    this.hits.clear()
  }

  remove(player: number): void {
    for (const [victim, hit] of this.hits) {
      if (victim === player || hit.killer === player) {
        this.hits.delete(victim)
      }
    }
  }

  /** The sim emits damage/kill before its shot report, so inspect the whole accepted batch first. */
  remember(events: readonly WireEvent[], tick: number, nowMs: number): void {
    const killed = new Map<number, number>()
    for (const [victim, hit] of this.hits) {
      if (hit.tick !== tick || nowMs - hit.atMs > MAX_AGE_MS) {
        this.hits.delete(victim)
      }
    }
    for (const event of events) {
      if (event.type === EV_KILL) {
        killed.set(event.victim, event.killer)
      } else if (
        event.type === EV_SHOT &&
        event.flags & SHOT_HIT &&
        event.target >= 0 &&
        event.target < MAX_PLAYERS &&
        killed.get(event.target) === event.shooter
      ) {
        const point = { x: shotCoord(event.ex), y: shotCoord(event.ey), z: shotCoord(event.ez) }
        const dx = point.x - shotCoord(event.ox)
        const dy = point.y - shotCoord(event.oy)
        const dz = point.z - shotCoord(event.oz)
        const length = Math.hypot(dx, dy, dz)
        if (!(Number.isFinite(length) && length > 1e-6)) {
          continue
        }
        let weapon: RagdollImpact['weapon'] = WEAPON_REVOLVER
        if (event.flags & SHOT_SHOTGUN) {
          weapon = WEAPON_SHOTGUN
        } else if (event.flags & SHOT_RIFLE) {
          weapon = WEAPON_RIFLE
        }
        this.hits.set(event.target, {
          impact: {
            point,
            direction: { x: dx / length, y: dy / length, z: dz / length },
            weapon,
          },
          killer: event.shooter,
          tick,
          atMs: nowMs,
        })
      }
    }
  }

  take(victim: number, killer: number, tick: number, nowMs: number): RagdollImpact | null {
    const hit = this.hits.get(victim)
    this.hits.delete(victim)
    const age = hit ? nowMs - hit.atMs : -1
    return hit && hit.killer === killer && hit.tick === tick && age >= 0 && age <= MAX_AGE_MS
      ? hit.impact
      : null
  }
}
