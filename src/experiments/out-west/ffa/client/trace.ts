// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `on` is flipped by the harness through `start()`/`stop()`; Biome narrows it to its initialiser
/**
 * Dev-only per-frame motion trace (`__frontierTrace` in dev builds): frame time, your rendered
 * position, the camera, the prediction, the server's acknowledged position and one remote rider,
 * for measuring stutter (per-frame displacement jitter) from Playwright. Fixed-size, no per-frame
 * allocation; off unless a harness starts it.
 */
export const TRACE_FIELDS = [
  't',
  'dtMs',
  'ownX',
  'ownZ',
  'camX',
  'camZ',
  'predX',
  'predZ',
  'srvX',
  'srvZ',
  'remX',
  'remZ',
  'renderTick',
  'ticks',
  'cpuMs',
] as const

const STRIDE = TRACE_FIELDS.length
const MAX_FRAMES = 4096

export class MotionTrace {
  private readonly buf = new Float64Array(STRIDE * MAX_FRAMES)
  private n = 0
  on = false

  start(): void {
    this.n = 0
    this.on = true
  }

  /** One frame, fields in `TRACE_FIELDS` order. */
  push(row: readonly number[]): void {
    if (!this.on || this.n >= MAX_FRAMES) {
      return
    }
    this.buf.set(row, this.n * STRIDE)
    this.n++
  }

  /** Stop and hand back the rows. */
  stop(): number[][] {
    this.on = false
    const rows: number[][] = []
    for (let i = 0; i < this.n; i++) {
      rows.push(Array.from(this.buf.subarray(i * STRIDE, (i + 1) * STRIDE)))
    }
    return rows
  }
}
