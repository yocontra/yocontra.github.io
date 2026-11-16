/** Summarize every presented frame, preserving stalls and empty one-second bins. */
export function frameTiming(timestamps: readonly number[]) {
  if (timestamps.length < 2 || timestamps.some((value) => !Number.isFinite(value))) {
    throw new Error('At least two finite frame timestamps are required')
  }
  const start = timestamps[0] as number
  const end = timestamps.at(-1) as number
  const intervals = timestamps.slice(1).map((value, index) => value - (timestamps[index] as number))
  if (intervals.some((value) => value <= 0)) {
    throw new Error('Frame timestamps must strictly increase')
  }
  const durationMs = end - start
  const bins = Array.from({ length: Math.ceil(durationMs / 1000) }, (_, index) => ({
    startMs: index * 1000,
    durationMs: Math.min(1000, durationMs - index * 1000),
    frames: 0,
  }))
  for (const timestamp of timestamps.slice(1)) {
    // Bins are (start, end], so a frame at exactly one second closes the first bin.
    const index = Math.ceil((timestamp - start) / 1000) - 1
    const bin = bins[index]
    if (bin) {
      bin.frames++
    }
  }
  const sorted = [...intervals].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] as number
  return {
    durationMs,
    frames: intervals.length,
    fps: (intervals.length * 1000) / durationMs,
    bins: bins.map((bin) => ({ ...bin, fps: (bin.frames * 1000) / bin.durationMs })),
    frameMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted.at(-1),
    },
    intervals,
  }
}
