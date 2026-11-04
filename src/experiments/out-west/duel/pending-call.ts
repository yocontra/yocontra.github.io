/** The call fires on the first frame at or after its time, within half a frame. */
export const CALL_FRAME_SLACK_MS = 8
/** Longest lead honoured from a server's `call.inMs`, ms (anything else presents at once). */
const MAX_LEAD_MS = 1000

/** The lead a server's call message asks for, clamped to something sane (0: present at once). */
export function callLead(inMs: unknown): number {
  return typeof inMs === 'number' && Number.isFinite(inMs)
    ? Math.min(MAX_LEAD_MS, Math.max(0, inMs))
    : 0
}

/**
 * A server call sent ahead of itself (`inMs`): held until its time so the director can schedule
 * the bell on the audio clock (`callAt`) and present DRAW! on the same instant (`due`).
 */
export class PendingCall {
  private duel = -1
  private at = 0
  private armed = false as boolean

  /** Hold `duel`'s call until `inMs` from now; false when it should be presented at once. */
  arm(duel: number, inMs: unknown): boolean {
    const lead = callLead(inMs)
    this.armed = lead > 0
    this.duel = duel
    this.at = performance.now() + lead
    return this.armed
  }

  /** perf time of the held call, if any. */
  get time(): number | null {
    return this.armed ? this.at : null
  }

  /** The held call's duel once its frame has come (and forgets it), else null. */
  due(now: number): number | null {
    if (!this.armed || now < this.at - CALL_FRAME_SLACK_MS) {
      return null
    }
    this.armed = false
    return this.duel
  }

  clear(): void {
    this.armed = false
  }
}
