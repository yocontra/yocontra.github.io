/**
 * Loop points (seconds into each file) written by `tools/audio/build.ts`. Do not edit by hand.
 * Each looped file is [lead-in | body | the body's first seconds again], so a streamed deck can
 * crossfade from `end` back to `start` over identical audio.
 */
export const LOOP_POINTS = {
  amb_crickets: { start: 2, end: 17 },
  amb_fire: { start: 2, end: 10.5 },
  amb_frontier_wind: { start: 0.25, end: 19.268_67 },
  amb_loco: { start: 0.25, end: 6.200_96 },
  amb_murmur: { start: 0.25, end: 16.25 },
  amb_piano: { start: 2, end: 23.5 },
  amb_saloon: { start: 2, end: 21 },
  amb_wind_day: { start: 2, end: 21 },
  amb_wind_dusk: { start: 2, end: 21 },
  amb_wind_night: { start: 2, end: 21 },
  fuse: { start: 0.15, end: 2.75 },
  m_act_day: { start: 5.838, end: 27.600_71 },
  m_act_day_hot: { start: 5.838, end: 27.600_71 },
  m_act_dusk: { start: 2.155_27, end: 26.107_69 },
  m_act_dusk_hot: { start: 2.155_27, end: 26.107_69 },
  m_act_night: { start: 2.534_48, end: 25.805_38 },
  m_act_night_hot: { start: 2.534_48, end: 25.805_38 },
  m_boss: { start: 48.4, end: 168.9499 },
  m_duel_day: { start: 2.005_71, end: 28.203_77 },
  m_duel_dusk: { start: 2.496_98, end: 26.496_92 },
  m_duel_night: { start: 1.3655, end: 23.366_71 },
  m_frontier: { start: 2, end: 23.760_77 },
  m_saloon: { start: 0.299_12, end: 26.088_23 },
  m_saloon_b: { start: 0.724_94, end: 23.568_17 },
  m_tension: { start: 2, end: 28.218 },
  m_title: { start: 22.7, end: 151.204_71 },
} as const satisfies Record<string, { start: number; end: number }>
