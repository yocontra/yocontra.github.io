/** Shared Frontier product controls, refusal types and gameplay constants.
 * HTTP joins validate the engine protocol and generated collision revision before reserving a
 * Colyseus seat. Native SDK schema/input packets travel over a signed, DO-owned WebSocket;
 * runtime/packets.ts batches two unmodified SDK inputs per outgoing WebSocket message.
 * ClientControl/ServerControl remain game-specific messages inside Colyseus ROOM_DATA.
 */

import { reopensOn } from '../data/sinks.ts'
import type { VoiceClientControl, VoiceServerControl } from './voice.ts'

/** Public product contract version. Colyseus handles binary schema evolution. */
export const CONTRACT_VERSION = 10
/** HTTP admission compatibility value (`TownJoinRequest.wire`). */
export const TOWN_WIRE_VERSION = 10

// --- saddlebags ----------------------------------------------------------------------------------

/**
 * The saddlebag cosmetics (§7: "the bag you drop in Frontier FFA"), by wire index. A player's
 * equipped saddlebag (validated against their inventory at join) sets the look of every bag they
 * drop: on death, on a lost showdown and on a disconnect. Cosmetic only: every style holds the same
 * money, sits at the same spot, and has the same pickup radius, exclusivity and expiry. An unknown
 * index renders as the Plain Sack.
 */
export const BAG_STYLES = ['bag.plain-sack', 'bag.branded-satchel', 'bag.gold-thread'] as const
export type BagStyle = (typeof BAG_STYLES)[number]

/** The wire index of a saddlebag item id (0, the Plain Sack, for anything else). */
export function bagStyleIndex(itemId: string | null | undefined): number {
  const i = (BAG_STYLES as readonly string[]).indexOf(itemId ?? '')
  return Math.max(0, i)
}

// --- HTTP ---------------------------------------------------------------------------------------

/** `POST /town/join` with `Authorization: Bearer <access token>`. Body optional. */
export interface TownJoinRequest {
  /** Ask for a specific lobby (e.g. "Ride to a busier town" or a rejoin). The directory may refuse. */
  lobbyId?: string
  /** Cloudflare Turnstile token, single use: required on every join, rejoins included (§8). */
  turnstileToken?: string
  /** Dev only (`RP_ID=localhost`): server bots to add, for load tests and `perf=ffa`. */
  bots?: number
  /** `TOWN_WIRE_VERSION` of the client; missing or older is refused with `outdated`. */
  wire?: number
}

export interface TownJoinResponse {
  lobbyId: string
  /** WebSocket URL with the single-use ticket already in the query string. */
  wsUrl: string
  /** Players in the lobby at assignment, including reserved rejoin slots. */
  players: number
}

/**
 * Refusals carry `{ ok: false, error, reason }` ({@link TownJoinError}): HTTP 503 (full or over
 * budget), 401 (signed out) or 403 `unlicensed` (Frontier needs the Bounty Hunt licence: the first
 * 3 outlaws beaten on a ranked run while signed in). `error` is ready to show as-is.
 */
/** `turnstile`: the join's Turnstile token was missing or failed (403); a fresh one may pass. */
export type TownJoinRefusal =
  | 'over_budget'
  | 'all_full'
  | 'unauthorized'
  | 'unlicensed'
  | 'turnstile'
  | 'outdated'

export interface TownJoinError {
  ok: false
  error: string
  reason: TownJoinRefusal
  /** With `unlicensed`: licence outlaws cleared so far and still to clear (of 3). */
  licence?: { cleared: number; remaining: number }
}

/** `GET /town/lobbies`: public directory for the hub tile ("12 in Perdition"). */
export interface TownDirectoryView {
  lobbies: { lobbyId: string; players: number; state: 'open' | 'draining' }[]
  open: boolean
}

// --- JSON control messages ----------------------------------------------------------------------

export interface RosterEntry {
  id: number
  name: string
  level: number
  prestige: number
  bot: boolean
  /** Cosmetic loadout item ids (validated server-side). */
  loadout: readonly string[]
}

/** Persistent world presentation, outside the capped transient-event list. Positions are metres. */
export interface TownPersistentState {
  /** Last completed simulation tick. Deadlines below use the same absolute tick clock. */
  tick: number
  bags: {
    id: number
    x: number
    z: number
    amount: number
    style: number
    exclusiveFor: number
    exclusiveUntil: number
    expiresAt: number
  }[]
  unavailablePickups: number[]
  brokenWindows: number[]
  callouts: { challenger: number; target: number; untilTick: number }[]
  showdowns: {
    id: number
    a: number
    b: number
    cx: number
    cz: number
    /** Null until the call has happened: never reveal the future call time. */
    calledTick: number | null
  }[]
  fuses: { player: number; x: number; z: number; explodeAt: number }[]
}

export type ServerControl =
  | {
      type: 'welcome'
      contractVersion: number
      lobbyId: string
      you: number
      tick: number
      tickHz: number
      roster: RosterEntry[]
      banked: number
    }
  | { type: 'town_state'; state: TownPersistentState }
  | { type: 'roster_add'; entry: RosterEntry }
  | { type: 'roster_remove'; id: number }
  /** A deposit was committed to the ledger (or failed and will retry). */
  | {
      type: 'deposit'
      seq: number
      amount: number
      commission: number
      banked: number
      ok: boolean
    }
  /** Showdown call: sent the instant the bell rings, on the same tick to both sockets. */
  | { type: 'showdown_call'; showdownId: number }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string; fatal: boolean }
  | VoiceServerControl

export type ClientControl =
  /** Showdown draw. `localMs` is the reaction measured on the client from the call it heard. */
  | { type: 'showdown_shot'; showdownId: number; localMs: number | null }
  /** Graceful leave without the 5 s channel (counts as a disconnect: carry drops). */
  | { type: 'bye' }
  | VoiceClientControl

// --- Binary message types -----------------------------------------------------------------------

export const MSG_INPUT = 1
export const MSG_SNAPSHOT = 2
export const MSG_FULL_RESET = 3

/** Position quantisation: units per metre. 144 m × 450 = 64800 fits a u16. */
export const POS_SCALE = 450
/** u16 angle units per full turn. */
export const ANGLE_SCALE = 65_536
/** Largest rewind the server applies to a shot, whatever the client claims. */
export const MAX_REWIND_MS = 200

export const INPUT_HEADER_BYTES = 7
export const INPUT_FRAME_BYTES = 10
export const MAX_FRAMES_PER_INPUT = 4
export const SNAPSHOT_HEADER_BYTES = 11
export const SNAPSHOT_SELF_BYTES = 66
/** `inputLead` when no input message arrived since the previous snapshot. */
export const INPUT_LEAD_NONE = -128

// --- Buttons (held state in each input frame) ---------------------------------------------------

export const BTN_FIRE = 1
/** Hold to aim from the holster (Dead-Eye). */
export const BTN_AIM = 2
export const BTN_ROLL = 4
export const BTN_RELOAD = 8
/** Contextual: bank, open a strongbox, accept a call-out. */
export const BTN_INTERACT = 16
/** Call out the player nearest your aim within 12 m. */
export const BTN_CALLOUT = 32
/** Hold-to-leave channel (5 s). */
export const BTN_LEAVE = 64
/** Throw dynamite (if you're holding a stick). */
export const BTN_THROW = 128
/** Jump: vault low cover you face (fences, rails, troughs, crates), or hop. See `VAULT_TICKS`. */
export const BTN_JUMP = 256
/**
 * Sprint (held): faster along your aim (within 50° of it), no shooting. A trigger pull drops the
 * sprint and the shot goes off `SPRINT_OUT_TICKS` later, as the gun comes up.
 */
export const BTN_SPRINT = 512
/** Crouch (held; the client makes it a toggle): slower, steadier. Pressed mid-sprint: a slide. */
export const BTN_CROUCH = 1024

/** Self block `moveFlags`: sprinting on the last tick. */
export const MOVE_SPRINTING = 1

export const WEAPON_REVOLVER = 0
export const WEAPON_SHOTGUN = 1
export const WEAPON_RIFLE = 2

/** Unpack the self block's `weapon` byte. */
export function selfWeapon(byte: number): { weapon: number; rounds: number; dynamite: boolean } {
  return { weapon: byte & 3, rounds: (byte >> 2) & 7, dynamite: (byte & 32) !== 0 }
}

// --- Snapshot flags -----------------------------------------------------------------------------

export const SNAP_FULL = 1
export const SNAP_TOWN = 2

export const SELF_ALIVE = 1
export const SELF_PROTECTED = 2
export const SELF_HOLSTERED = 4
export const SELF_MOST_WANTED = 8
export const SELF_IN_SHOWDOWN = 16
export const SELF_FROZEN = 32
export const SELF_RELOADING = 64
export const SELF_DEAD_EYE_READY = 128

export const ENT_POS = 1
export const ENT_POS_FULL = 2
export const ENT_AIM = 4
export const ENT_HP = 8
export const ENT_FLAGS = 16
export const ENT_ANIM = 32
export const ENT_CARRY = 64
/** Aim pitch, `i8` (±127 = ±90°, up positive): wire v6. */
export const ENT_PITCH = 128

export const EF_ALIVE = 1
export const EF_PROTECTED = 2
export const EF_HOLSTERED = 4
export const EF_MOST_WANTED = 8
export const EF_SHOWDOWN = 16
export const EF_CHANNELING = 32
export const EF_HATLESS = 64
export const EF_LINGERING = 128

export const ANIM_IDLE = 0
export const ANIM_RUN = 1
export const ANIM_ROLL = 2
export const ANIM_RELOAD = 3
export const ANIM_DEAD = 4
export const ANIM_AIM = 5
export const ANIM_CHANNEL = 6
export const ANIM_DUEL = 7
/** Mid-vault (0.5 s arc over low cover). */
export const ANIM_VAULT = 8
/** A jump (0.55 s in the air, steered a little). */
export const ANIM_HOP = 9
/** A slide (0.65 s along the ground, from a sprint). */
export const ANIM_SLIDE = 10
/** The `ANIM_*` part of an entity's `anim` byte. */
export const ANIM_MASK = 15
/** Stance bits above the anim nibble: crouched, on the sights, sprinting. */
export const STANCE_CROUCH = 16
export const STANCE_ADS = 32
export const STANCE_SPRINT = 64

export const CHANNEL_NONE = 0
export const CHANNEL_BANK = 1
export const CHANNEL_STAGE = 2
export const CHANNEL_STRONGBOX = 3
export const CHANNEL_LEAVE = 4

export const BOX_NONE = 0
export const BOX_WAITING = 1
export const BOX_OPENING = 2

// --- Events -------------------------------------------------------------------------------------

/**
 * `u8 shooter, u16 aim, u8 rangeQ, u8 target, u8 flags, u8 y` (legacy range metadata),
 * six `u16` coordinates (`ox,oy,oz,ex,ey,ez`, biased centimetres), `u8 pelletCount`, then
 * `pelletCount × (u16 x,u16 y,u16 z)`. One event per shell; pellet count is 0 or 8.
 */
export const EV_SHOT = 1
/** `u8 victim, u8 attacker, u8 amount, u8 hpAfter` */
export const EV_DAMAGE = 2
/** `u8 victim, u8 killer (255 none), u8 flags (KILL_*), u16 bounty` */
export const EV_KILL = 3
/**
 * `u16 bagId, u16 x, u16 z, u16 amount, u8 exclusiveFor (255 none), u8 style` where `style` is the
 * dropper's saddlebag cosmetic, an index into {@link BAG_STYLES} (render the bag in that look).
 */
export const EV_BAG_DROP = 4
/** `u16 bagId, u8 by (255 expired/burned)` */
export const EV_BAG_GONE = 5
/** `u8 player, u16 amount, u16 commission` (deposit committed in-sim; ledger confirm comes as JSON) */
export const EV_DEPOSIT = 6
/** `u8 player` */
export const EV_RESPAWN = 7
/** `u8 spot, u16 value` */
export const EV_STRONGBOX_SPAWN = 8
/** `u8 spot, u8 by, u16 value` */
export const EV_STRONGBOX_OPEN = 9
/** `u8 challenger, u8 target` (target has `CALLOUT_ACCEPT_MS` to accept) */
export const EV_CALLOUT = 10
/** `u16 showdownId, u8 a, u8 b, u16 cx, u16 cz` (ring formed; both frozen) */
export const EV_SHOWDOWN_START = 11
/** `u16 showdownId, u8 cue` (0–8 fake-out cue index) */
export const EV_SHOWDOWN_FAKE = 12
/** `u16 showdownId` (the bell; the JSON `showdown_call` is the precise one) */
export const EV_SHOWDOWN_CALL = 13
/** `u16 showdownId, u8 winner (255 none), u8 outcome (SD_*), u16 winnerMs` */
export const EV_SHOWDOWN_END = 14
/** `u8 player, u8 kind (CHANNEL_*)` */
export const EV_CHANNEL_CANCEL = 15
/** `u8 player` (hat knocked off by a Dead-Eye shot) */
export const EV_HAT_OFF = 16
/** `u8 player` (the leave channel finished; the socket closes next) */
export const EV_LEFT = 17

/** `u8 spot, u8 player` (255: replayed on a full snapshot, taken earlier) */
export const EV_PICKUP_TAKEN = 18
/** `u8 spot` (respawned) */
export const EV_PICKUP_READY = 19
/** `u8 player, u16 x, u16 z, u8 fuseTicks` (where it landed, and ticks until it blows) */
export const EV_DYNAMITE_THROWN = 20
/** `u8 by, u16 x, u16 z` */
export const EV_EXPLOSION = 21
/** `u16 window` (index into the shared town window order) */
export const EV_GLASS_BREAK = 22

export const EVENT_SIZES: Readonly<Record<number, number>> = {
  [EV_SHOT]: 20,
  [EV_DAMAGE]: 4,
  [EV_KILL]: 5,
  [EV_BAG_DROP]: 10,
  [EV_BAG_GONE]: 3,
  [EV_DEPOSIT]: 5,
  [EV_RESPAWN]: 1,
  [EV_STRONGBOX_SPAWN]: 3,
  [EV_STRONGBOX_OPEN]: 4,
  [EV_CALLOUT]: 2,
  [EV_SHOWDOWN_START]: 8,
  [EV_SHOWDOWN_FAKE]: 3,
  [EV_SHOWDOWN_CALL]: 2,
  [EV_SHOWDOWN_END]: 6,
  [EV_CHANNEL_CANCEL]: 2,
  [EV_HAT_OFF]: 1,
  [EV_LEFT]: 1,
  [EV_PICKUP_TAKEN]: 2,
  [EV_PICKUP_READY]: 1,
  [EV_DYNAMITE_THROWN]: 6,
  [EV_EXPLOSION]: 5,
  [EV_GLASS_BREAK]: 2,
}

/** Shot coordinate metres = (wire - SHOT_COORD_BIAS) / SHOT_COORD_SCALE. */
export const SHOT_COORD_SCALE = 100
export const SHOT_COORD_BIAS = 32_768
export const MAX_SHOT_PELLETS = 8

/** Shot range units: metres = rangeQ × SHOT_RANGE_UNIT. */
export const SHOT_RANGE_UNIT = 0.25

export const SHOT_HIT = 1
export const SHOT_DEAD_EYE = 2
export const SHOT_WALL = 4
export const SHOT_SHOTGUN = 8
export const SHOT_RIFLE = 16

export const KILL_DEAD_EYE = 1
export const KILL_PARDON = 2
export const KILL_SHOWDOWN = 4
export const KILL_MOST_WANTED = 8
/** Repeat victim (4th+ kill within 10 min): no bounty, no XP. */
export const KILL_FARMED = 16

export const SD_WIN = 1
export const SD_DEAD_HEAT = 2
export const SD_FROZE = 3
export const SD_COWARD = 4
export const SD_ABORTED = 5

/** No-one / nothing, for u8 ids. */
export const NONE = 255

/** Frontier's "closed for the month" line (the join route's `over_budget` refusal says the same). */
export function townClosedCopy(now = new Date()): string {
  return `Frontier is closed until ${reopensOn(now)} (UTC). Quick Draw is still open.`
}
