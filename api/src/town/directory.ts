/** Frontier lobby directory: always joinable, rollover at the cap, fills the fullest lobby. Owned by stream F. */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'

export class LobbyDirectory extends DurableObject<Env> {
  // biome-ignore lint/suspicious/useAwait: stub until stream F implements it
  override async fetch(): Promise<Response> {
    return new Response('Not implemented', { status: 501 })
  }
}
