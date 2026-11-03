/** One Frontier lobby: authoritative 20 Hz tick, only while occupied. Owned by stream F. */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'

export class Lobby extends DurableObject<Env> {
  // biome-ignore lint/suspicious/useAwait: stub until stream F implements it
  override async fetch(): Promise<Response> {
    return new Response('Not implemented', { status: 501 })
  }
}
