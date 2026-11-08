/** Quality decisions use a complete rolling second, so short loading stalls cannot ratchet it. */
export class FrameBudget {
  readonly minimumPixelRatio = 1
  private readonly samples: number[] = []
  private elapsed = 0
  private stableSeconds = 0
  pixelRatio: number
  fps = 0
  worstFps = Number.POSITIVE_INFINITY
  constructor(maxPixelRatio = 1.5) {
    this.pixelRatio = Math.max(this.minimumPixelRatio, Math.min(2, maxPixelRatio))
    this.maximumPixelRatio = this.pixelRatio
  }
  readonly maximumPixelRatio: number
  beginMeasurement(): void {
    this.reset()
    this.fps = 0
    this.worstFps = Number.POSITIVE_INFINITY
  }
  reset(): void {
    this.samples.length = 0
    this.elapsed = 0
    this.stableSeconds = 0
  }
  sample(seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      this.reset()
      return false
    }
    this.samples.push(seconds)
    this.elapsed += seconds
    while (this.samples.length > 1 && this.elapsed - (this.samples[0] ?? 0) >= 1) {
      this.elapsed -= this.samples.shift() ?? 0
    }
    if (this.elapsed < 1) {
      return false
    }
    this.fps = this.samples.length / this.elapsed
    this.worstFps = Math.min(this.worstFps, this.fps)
    const previous = this.pixelRatio
    if (this.fps < 35) {
      this.stableSeconds = 0
      this.pixelRatio = Math.max(this.minimumPixelRatio, this.pixelRatio - 0.125)
    } else if (this.fps > 55) {
      this.stableSeconds += seconds
      if (this.stableSeconds >= 10) {
        this.pixelRatio = Math.min(this.maximumPixelRatio, this.pixelRatio + 0.125)
      }
    } else {
      this.stableSeconds = 0
    }
    if (previous !== this.pixelRatio) {
      this.reset()
    }
    return previous !== this.pixelRatio
  }
}
