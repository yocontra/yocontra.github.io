/** Every binding the Worker and its Durable Objects can see. Owned by the lead; ask before adding. */

import type { DailySession } from './daily/session.ts'
import type { Matchmaker } from './duel/matchmaker.ts'
import type { DuelRoom } from './duel/room.ts'
import type { DuelSession } from './session.ts'
import type { LobbyDirectory } from './town/directory.ts'
import type { Lobby } from './town/lobby.ts'

export interface Env {
  DB: D1Database
  /** Ranked single-player gauntlet runs (one object per run). */
  DUELS: DurableObjectNamespace<DuelSession>
  /** One object per Daily Outlaw attempt (meta-game stream). */
  DAILY_SESSIONS: DurableObjectNamespace<DailySession>
  /** Bounty Hunt matchmaking (sharded by bracket; see stream B). */
  MATCHMAKER: DurableObjectNamespace<Matchmaker>
  /** One object per Bounty Hunt PvP or ghost duel. */
  DUEL_ROOMS: DurableObjectNamespace<DuelRoom>
  /** Frontier lobby directory (a singleton). */
  LOBBY_DIR: DurableObjectNamespace<LobbyDirectory>
  /** One object per Frontier lobby. */
  LOBBIES: DurableObjectNamespace<Lobby>
  /**
   * Per-IP limit on guest (untokened) Daily tries, checked before any D1 or Durable Object work
   * (`routes/daily.ts`). Optional: absent in unit tests that don't exercise it.
   */
  DAILY_GUEST_LIMIT?: RateLimit
  /** Comma-separated list of origins allowed to call the API from a browser. */
  ALLOWED_ORIGINS: string
  /** Cloudflare Turnstile secret. Local dev uses Cloudflare's always-pass test secret. */
  TURNSTILE_SECRET: string
  /** HMAC key for access tokens and one-time codes (stream A). */
  AUTH_SECRET: string
  /** WebAuthn relying-party id, e.g. `contra.io` (local dev: `localhost`). */
  RP_ID: string
  /** Comma-separated origins WebAuthn accepts, e.g. `https://contra.io`. */
  RP_ORIGINS: string
}
