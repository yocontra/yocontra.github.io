/**
 * Loop points (seconds into each file) written by `tools/audio/build.ts`. Do not edit by hand.
 * Each looped file is [lead-in | body | the body's first seconds again], so a streamed deck can
 * crossfade from `end` back to `start` over identical audio.
 */
export const LOOP_POINTS = {
  amb_crickets: { start: 2, end: 17 },
  amb_fire: { start: 2, end: 10.5 },
  amb_piano: { start: 2, end: 23.5 },
  amb_saloon: { start: 2, end: 21 },
  amb_wind_day: { start: 2, end: 21 },
  amb_wind_dusk: { start: 2, end: 21 },
  amb_wind_night: { start: 2, end: 21 },
  fuse: { start: 0.15, end: 2.75 },
  m_boss: { start: 48.4, end: 168.9499 },
  m_frontier: { start: 2, end: 23.760_77 },
  m_tension: { start: 2, end: 28.218 },
  m_title: { start: 22.7, end: 151.204_71 },
} as const satisfies Record<string, { start: number; end: number }>
