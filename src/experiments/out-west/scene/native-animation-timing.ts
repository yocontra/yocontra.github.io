import type { AnimTrack } from 'playcanvas'

/** Recoil completes inside the presentation window; weapon fire cadence stays authoritative. */
export const RECOIL_SECONDS = 0.2

/** Set fixed action rates when building native graphs, before their AnimClips are created. */
export function nativeActionSpeed(track: Pick<AnimTrack, 'name' | 'duration'>): number {
  return track.name.includes('Shoot') ? track.duration / RECOIL_SECONDS : 1
}
