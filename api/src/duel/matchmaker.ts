/** Bounty Hunt queue: brackets widen over time, ghost fallback at 18 s. Owned by stream B. */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'

export class Matchmaker extends DurableObject<Env> {
  // biome-ignore lint/suspicious/useAwait: stub until stream B implements it
  override async fetch(): Promise<Response> {
    return new Response('Not implemented', { status: 501 })
  }
}
