/** One Bounty Hunt duel (two humans, or a human and a ghost). Server-authoritative. Owned by stream B. */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'

export class DuelRoom extends DurableObject<Env> {
  // biome-ignore lint/suspicious/useAwait: stub until stream B implements it
  override async fetch(): Promise<Response> {
    return new Response('Not implemented', { status: 501 })
  }
}
