export interface ForegroundSample {
  wall: number
  bundle: string
  pid: number
  onScreenWindows: number
}

/** Sampling overhead may yield 59 samples in a minute; coverage and gaps prove continuity. */
export function foregroundCoverage(
  samples: ForegroundSample[],
  expected: { start: number; end: number; bundle: string; pid: number | undefined },
) {
  const maximumGapMs = Math.max(
    0,
    ...samples
      .slice(1)
      .map((sample, index) => sample.wall - (samples[index]?.wall ?? Number.NEGATIVE_INFINITY)),
  )
  const startOffsetMs = (samples[0]?.wall ?? Number.POSITIVE_INFINITY) - expected.start
  const endOffsetMs = (samples.at(-1)?.wall ?? Number.NEGATIVE_INFINITY) - expected.end
  const validIdentity = Number.isFinite(expected.pid) && (expected.pid ?? 0) > 0
  const correctWindow = samples.every(
    (sample) =>
      sample.bundle === expected.bundle &&
      sample.pid === expected.pid &&
      sample.onScreenWindows >= 1,
  )
  const chronological = samples.every(
    (sample, index) =>
      Number.isFinite(sample.wall) &&
      (index === 0 || sample.wall > (samples[index - 1]?.wall ?? Number.POSITIVE_INFINITY)),
  )
  return {
    sampleCount: samples.length,
    startOffsetMs,
    endOffsetMs,
    maximumGapMs,
    passed:
      samples.length >= 2 &&
      expected.end > expected.start &&
      validIdentity &&
      correctWindow &&
      chronological &&
      Math.abs(startOffsetMs) <= 1000 &&
      Math.abs(endOffsetMs) <= 1000 &&
      maximumGapMs <= 1750,
  }
}
