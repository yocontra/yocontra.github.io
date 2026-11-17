import type { AnimTrack } from 'playcanvas'

/** Recoil completes inside the presentation window; weapon fire cadence stays authoritative. */
export const RECOIL_SECONDS = 0.2
/** Presentation only: the authoritative fuse starts when the server accepts the toss. */
export const DYNAMITE_RELEASE_SECONDS = 0.2
export const DYNAMITE_THROW_SECONDS = 0.7

/** Set fixed action rates when building native graphs, before their AnimClips are created. */
export function nativeActionSpeed(track: Pick<AnimTrack, 'name' | 'duration'>): number {
  return track.name.includes('Shoot') ? track.duration / RECOIL_SECONDS : 1
}
