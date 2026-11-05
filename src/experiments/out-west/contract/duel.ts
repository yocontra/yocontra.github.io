/**
 * Bounty Hunt HTTP and WebSocket message types (queue, match, duel room).
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream B.
 *
 * # Flow
 *
 * 1. `POST /queue/ticket` with `Authorization: Bearer <access token>` and a {@link QueueTicketRequest}
 *    returns a {@link QueueTicketResponse}: a single-use ticket and the queue socket URL.
 *    (A generic `POST /tickets { purpose: 'duel' }` ticket from stream A works too.)
 *    Other routes: `GET /duel/:matchId` ({@link MatchSummary}), `GET|PUT /duel/settings`
 *    ({@link DuelSettings}) and `GET /duel/stats` ({@link DuelStatsResponse}), all with Bearer auth.
 * 2. Open `GET /queue/ws?ticket=…`. The queue speaks {@link QueueServerMessage} and
 *    {@link QueueClientMessage}. Answer every `ping` with a `pong` straight away: the matchmaker uses
 *    the round trip to keep bad connections out of human duels.
 * 3. On `matched`, close the queue socket and open `matched.wsUrl` (it already carries the reusable
 *    room token). The room speaks {@link RoomServerMessage} and {@link RoomClientMessage}.
 * 4. To reconnect after a drop (Wi-Fi to cellular, app backgrounded), reopen the same `wsUrl`. The
 *    token is reusable for the life of the match. The server sends a full `sync` on rejoin. Grace is
 *    {@link RECONNECT_GRACE_MS} before the call and none after it.
 *
 * # Room beat sheet (the server owns the clock)
 *
 * ```
 * hello ─▶ intro (3 s) ─▶ cock: send `ready` (10 s, or you dodge)
 *       ─▶ walk: hold to walk; a `pace` every 500 ms while BOTH hold (stall: heckle 6 s, auto 10 s)
 *       ─▶ turn (600 ms) ─▶ wait: 0–2 `cue` fake-outs ─▶ `call` ─▶ send `shot` ─▶ `result`
 *       ─▶ (`deadHeat` ─▶ `suddenDeath` wait ─▶ `call` ─▶ …)
 *       ─▶ rematch window (20 s from the settled `result`): both send `rematch` ─▶ `hello` again
 *          with `rematch > 0`, no intro
 * ```
 *
 * Every timed message carries `serverTime` (the server's epoch ms) so the client can show
 * countdowns; never use it to time the call. `call` comes `inMs` ahead of itself: the client
 * presents it (bell, DRAW!) `inMs` after it arrives, scheduled on the audio clock, judges its own
 * press on `pointerdown` `event.timeStamp` relative to that moment, and reports it as `localMs`.
 *
 * All money is whole dollars. All times are milliseconds unless the name says otherwise.
 */
import type { Loadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'

export const CONTRACT_VERSION = 1

// --- constants the client may display ------------------------------------------------------------

export const INTRO_MS = 3000
export const READY_TIMEOUT_MS = 10_000
export const PACE_MS = 500
export const STALL_HECKLE_MS = 6000
export const STALL_AUTO_WALK_MS = 10_000
export const TURN_MS = 600
export const JUDGE_TIMEOUT_MS = 1500
export const RESULT_MS = 4500
/**
 * How long both players have to vote for a rematch, counted from when the settled `result` is sent
 * (the `rematch` message carries the deadline). The client plays a 2–4 s kill cam before its results
 * sheet, so this leaves a good 15 s to read the sheet and click.
 */
export const REMATCH_WINDOW_MS = 20_000
export const MAX_REMATCHES = 5
export const RECONNECT_GRACE_MS = 5000
/** The "Duel a ghost now" button appears after this long in the queue. */
export const GHOST_BUTTON_AFTER_MS = 8000
/** The matchmaker gives you a ghost after this long. */
export const GHOST_FALLBACK_MS = 18_000

/** Fake-out cues a Bounty Hunt duel can play. Never a bell timbre. */
export const PVP_CUES = [
  'crow',
  'creak',
  'dog',
  'tumbleweed',
  'coin',
  'bottle',
  'gust',
  'whistle',
  'piano-stop',
] as const
export type PvpCue = (typeof PVP_CUES)[number]

/** Fixed-list taunts. No free text anywhere. */
export const TAUNTS = [
  'draw',
  'your-move',
  'nice-hat',
  'say-your-prayers',
  'tip-hat',
  'good-duel',
] as const
export type Taunt = (typeof TAUNTS)[number]

// --- shared shapes -------------------------------------------------------------------------------

/** 0 or 1. Your seat is in `hello.you`. */
export type Seat = 0 | 1

/** What the opponent's poster shows. A ghost carries only what an opponent already sees. */
export interface Poster {
  name: string
  level: number
  prestige: number
  /** Live bounty: base bounty with the hot-streak bonus. */
  bounty: number
  streak: number
  /** Public cowardice tally. */
  cowardice: number
  /**
   * Server-validated cosmetic loadout (stream C's `Loadout`, run through `normalizeLoadout`). An
   * unknown id falls back to the starter item on the client.
   */
  loadout: Loadout
  /** The dye on each dyed item in the loadout (absent: natural, or a server that predates dyes). */
  dyes?: Dyes
  /** `'human'` for a live player, `'ghost'` for a recorded player, `'outlaw'` for a Town Outlaw. */
  kind: OpponentKind
}

export type OpponentKind = 'human' | 'ghost' | 'outlaw'

export type DuelMode = 'pvp' | 'ghost'

// --- HTTP ----------------------------------------------------------------------------------------

/** `POST /queue/ticket` (Bearer auth). */
export interface QueueTicketRequest {
  /** Cloudflare Turnstile token. Required in production. */
  turnstileToken: string
}

export interface QueueTicketResponse {
  ticket: string
  /** `wss://…/queue/ws?ticket=…` */
  wsUrl: string
}

/** Error body for every non-2xx response: `{ ok: false, error }`. */
export interface DuelHttpError {
  ok: false
  error: string
}

/** `GET /duel/:matchId` (Bearer auth, either player): the committed outcome, once settled. */
export interface MatchSummary {
  matchId: string
  mode: DuelMode
  outcome: MatchOutcome | null
  settled: boolean
}

/** `GET /duel/settings` and `PUT /duel/settings` (Bearer): "Let my ghost ride" (on by default). */
export interface DuelSettings {
  /** True when the player has switched their ghost off. Opting out deletes the ghost at once. */
  ghostOptOut: boolean
}

/** `GET /duel/stats` (Bearer): the player's public Bounty Hunt standing. */
export interface DuelStatsResponse {
  streak: number
  bestStreak: number
  wins: number
  losses: number
  draws: number
  cowardice: number
}

// --- queue socket --------------------------------------------------------------------------------

export type QueueClientMessage =
  /** Reply to `ping` immediately with the same `n`. */
  | { type: 'pong'; n: number }
  /** "Duel a ghost now". Accepted once `status.ghostButton` is true. */
  | { type: 'ghost' }
  /** Leave the queue. The server closes the socket. */
  | { type: 'leave' }

export type QueueRefusal =
  /** The monthly spend cap is reached. Try again next month. */
  | 'budget'
  /** Signed-in but no licence yet: beat the first 3 outlaws on a ranked run. */
  | 'unlicensed'
  /** 3 dodges in 10 minutes: a 5-minute cooldown. `retryAfterS` says how long is left. */
  | 'cooldown'
  /** Already in the queue or in a duel from another tab or device. */
  | 'busy'
  /** Ticket missing, expired or used. */
  | 'unauthorized'
  /** No profile yet. */
  | 'no-profile'

export type QueueServerMessage =
  | {
      type: 'queued'
      serverTime: number
      /** Your effective level, `min(50, level + 10·prestige)`. */
      effectiveLevel: number
      /** True if your connection is too rough for human duels (RTT > 250 ms or jitter > 50 ms). */
      ghostsOnly: boolean
    }
  | { type: 'ping'; n: number }
  /** Once a second while you wait. */
  | {
      type: 'status'
      serverTime: number
      waitedMs: number
      /** Players waiting in the queue, including you. */
      waiting: number
      /** Current effective-level window, ±. */
      levelWindow: number
      /** Current rating window, ± ms, or null for any. */
      ratingWindow: number | null
      /** Show the "Duel a ghost now" button. */
      ghostButton: boolean
      ghostsOnly: boolean
    }
  | {
      type: 'matched'
      matchId: string
      mode: DuelMode
      /** Open this socket next. It includes the reusable room token. */
      wsUrl: string
      opponent: Poster
    }
  | { type: 'refused'; reason: QueueRefusal; message: string; retryAfterS?: number }
  | { type: 'error'; message: string }

// --- room socket ---------------------------------------------------------------------------------

export type RoomClientMessage =
  /** Reply to `ping` immediately. */
  | { type: 'pong'; n: number }
  /** Cocked and ready (the cock beat). */
  | { type: 'ready' }
  /** Walk control: `true` while the walk button or key is held, `false` on release. */
  | { type: 'hold'; down: boolean }
  /**
   * You fired. `localMs` is ms from presenting `call` (its arrival plus `inMs`) to the press,
   * measured on the client (`pointerdown` `event.timeStamp`). Send `null` if you pressed before
   * the call was presented:
   * that is cowardice. Only the first shot of each draw counts; later ones are ignored.
   */
  | { type: 'shot'; draw: number; localMs: number | null }
  /** Fixed-list taunt during the intro or results. Rate-limited to one every 2 s. */
  | { type: 'taunt'; taunt: Taunt }
  /** Ask for a rematch during the rematch window. */
  | { type: 'rematch' }
  /** "Flee": counts as a dodge before the walk starts and a forfeit after. Results: just leaves. */
  | { type: 'flee' }
  /** Ask for a RealtimeKit participant token (proximity voice). */
  | { type: 'voice_on' }
  | { type: 'voice_off' }

/** A beat of the duel. `sync` and `beat` carry the current one. */
export type Beat =
  | 'intro'
  | 'cock'
  | 'walk'
  | 'turn'
  | 'wait'
  | 'called'
  | 'result'
  | 'rematch'
  | 'closed'

export type MatchOutcome =
  /** A clean kill after the call. */
  | 'win'
  /** Somebody drew early (or under 100 ms). */
  | 'coward'
  /** Somebody dropped before the call and did not return within the grace, or fled after cocking. */
  | 'forfeit'
  /** Somebody was not ready within 10 s or quit during the intro. */
  | 'dodge'
  /** Two dead heats in a row. */
  | 'draw'
  /** Neither fired within 1.5 s of the call. */
  | 'froze'

/** Your side of the settlement. */
export interface Settlement {
  /** Net change to your purse (negative for a loss). */
  delta: number
  xp: number
  /** Your purse after settlement, if known. */
  purse: number | null
  /** Your new streak. */
  streak: number
  /** Pair diminishing-returns multiplier that applied, 0..1. */
  pairFactor: number
  /**
   * Itemised lines for the results screen. When the duel levelled you up, the last line is
   * `Level up · Lv N` with the level reward exactly as the ledger booked it.
   */
  lines: readonly { label: string; amount: number; xp: number }[]
  /**
   * Your XP and level just before and just after this duel, from the server's committed profile.
   * Use these (not an XP figure captured when you queued: across rematches that goes stale and
   * double-counts level rewards).
   */
  xpBefore: number
  xpAfter: number
  levelBefore: number
  levelAfter: number
  /** Dollars the level-ups in this duel paid ($25 × each new level), as booked. 0 if none. */
  levelReward: number
}

/** The level-up numbers of a settlement. */
export type SettlementLevels = Pick<
  Settlement,
  'xpBefore' | 'xpAfter' | 'levelBefore' | 'levelAfter' | 'levelReward'
>

/** A settlement's level-up numbers, or null when there is no settlement. */
export function settlementLevels(s: Settlement | null | undefined): SettlementLevels | null {
  return s
    ? {
        xpBefore: s.xpBefore,
        xpAfter: s.xpAfter,
        levelBefore: s.levelBefore,
        levelAfter: s.levelAfter,
        levelReward: s.levelReward,
      }
    : null
}

export interface DuelResult {
  type: 'result'
  serverTime: number
  matchId: string
  draw: number
  outcome: MatchOutcome
  /** The winner's seat, or null for a draw, a freeze, or a double dead heat. */
  winner: Seat | null
  /** For coward, forfeit and dodge: who did it. */
  culprit: Seat | null
  /** Judged reaction per seat (ms from the call), null if that seat did not fire. */
  reactions: readonly [number | null, number | null]
  /** Dead heats before this result. */
  deadHeats: number
  /** Your side of the money. Null for a spectator or before settlement commits. */
  you: Settlement | null
  /** True once the match row and ledger commit. */
  settled: boolean
}

export type RoomServerMessage =
  | {
      type: 'hello'
      serverTime: number
      matchId: string
      mode: DuelMode
      you: Seat
      /** Index 0 and 1 by seat. */
      posters: readonly [Poster, Poster]
      /** 0 for the first duel; 1..5 for rematches (no intro). */
      rematch: number
    }
  /** Full state, sent on (re)connect. */
  | {
      type: 'sync'
      serverTime: number
      beat: Beat
      /** Epoch ms when the current beat times out, if it does. */
      deadline: number | null
      pace: number
      draw: number
      ready: readonly [boolean, boolean]
      holding: readonly [boolean, boolean]
      connected: readonly [boolean, boolean]
      last: DuelResult | null
    }
  | { type: 'ping'; n: number }
  /** The beat changed. */
  | { type: 'beat'; serverTime: number; beat: Beat; deadline: number | null }
  /** A seat cocked. */
  | { type: 'ready'; seat: Seat }
  /** Walk holds changed. The walk only advances while both are true. */
  | { type: 'holding'; holding: readonly [boolean, boolean] }
  /** One pace taken. The total count stays hidden until `turn`. */
  | { type: 'pace'; n: number; auto: boolean }
  /** The walk stalled for 6 s: show a heckle caption. At 10 s the server auto-walks. */
  | { type: 'heckle' }
  /** A fake-out. Never the call. */
  | { type: 'cue'; draw: number; cue: PvpCue | string }
  /**
   * DRAW!, sent `inMs` ahead: present it `inMs` after it arrives (absent or 0: at once). Both
   * sockets get this on the same server tick.
   */
  | { type: 'call'; draw: number; inMs?: number }
  /** Both shots landed within 5 ms. Both men fall; sudden death follows (no walk). */
  | {
      type: 'deadHeat'
      draw: number
      reactions: readonly [number | null, number | null]
      deadHeats: number
    }
  /** A new wait begins after a dead heat. Expect `cue`s and a `call` with this `draw`. */
  | { type: 'suddenDeath'; draw: number }
  | DuelResult
  /** The opponent's connection changed. */
  | { type: 'presence'; seat: Seat; connected: boolean; graceUntil: number | null }
  | { type: 'taunt'; seat: Seat; taunt: Taunt }
  /** A Cloudflare RealtimeKit voice meeting this seat may join. */
  | { type: 'voice_ready'; meetingId: string; token: string }
  | { type: 'voice_error'; message: string }
  /** Rematch votes; the window closes at `deadline`. */
  | { type: 'rematch'; votes: readonly [boolean, boolean]; deadline: number; left: number }
  | { type: 'error'; message: string; fatal: boolean }
  /** The room is done; the socket closes next. */
  | { type: 'closed'; reason: 'done' | 'opponent-left' | 'timeout' | 'error' }
