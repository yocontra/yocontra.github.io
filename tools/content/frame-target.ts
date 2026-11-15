import type { frameTiming } from './frame-timing.ts'

/** Desktop aims near 60 Hz; the simulator floor is a separate 30 Hz acceptance target. */
export function frameTarget(
  timing: ReturnType<typeof frameTiming>,
  surface: 'desktop' | 'simulator',
) {
  const meanFps = surface === 'desktop' ? 58 : 30
  const minimumFullSecondFps = surface === 'desktop' ? 55 : 30
  const full = timing.bins.filter((bin) => bin.durationMs === 1000)
  const lowestFullSecondFps = Math.min(...full.map((bin) => bin.fps))
  return {
    meanFps,
    minimumFullSecondFps,
    lowestFullSecondFps,
    passed:
      full.length >= 60 && timing.fps >= meanFps && lowestFullSecondFps >= minimumFullSecondFps,
  }
}
