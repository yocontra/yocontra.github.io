import { RTT_SAMPLES } from '../net/constants.ts'

/** Server-owned nonce probes for game judging; client clock/RTT claims are never used. */
export class GameLinkSampler {
  private nextProbeAt = 0
  private pending: { nonce: string; at: number } | undefined
  private readonly samples: number[]
  private readonly send: (nonce: string) => void
  constructor(samples: number[], send: (nonce: string) => void) {
    this.samples = samples
    this.send = send
  }
  activity(now: number) {
    if (now < this.nextProbeAt) {
      return
    }
    const nonce = crypto.randomUUID()
    this.nextProbeAt = now + 5000
    this.pending = { nonce, at: now }
    this.send(nonce)
  }
  pong(message: unknown, now: number) {
    const pending = this.pending
    if (
      !pending ||
      typeof message !== 'object' ||
      message === null ||
      Reflect.get(message, 'nonce') !== pending.nonce
    ) {
      return
    }
    this.pending = undefined
    const rtt = now - pending.at
    if (!Number.isFinite(rtt) || rtt < 0 || rtt >= 2000) {
      return
    }
    this.samples.push(rtt)
    if (this.samples.length > RTT_SAMPLES) {
      this.samples.shift()
    }
  }
}
