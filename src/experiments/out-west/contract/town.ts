/**
 * Frontier HTTP types, JSON control messages, and the binary snapshot/input codec spec.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream F.
 *
 * The codec itself is `ffa/sim/codec.ts`; this file is its spec and the shared constants.
 *
 * # Transport
 *
 * One WebSocket per player: `GET {wsUrl}` where `wsUrl` comes from `POST /town/join` and already
 * carries `?ticket=` (single use, 30 s, purpose `town`). Binary frames carry inputs and snapshots,
 * text frames carry JSON control messages (`ClientControl` / `ServerControl`).
 * The socket is TCP: every frame arrives, in order, or the socket dies. Delta compression therefore
 * diffs against the **last snapshot sent** to that socket, and a reconnect always starts from a full
 * snapshot. There are no app-level pings: RTT comes from `ackTick`/`ackAgeMs` on inputs.
 *
 * All multi-byte integers are little-endian. Positions are quantised to `POS_SCALE` units per metre
 * (u16 covers the 144 m town at 2.2 mm). Angles are u16 turns (`ANGLE_SCALE` units per 2π), or u8
 * turns on remote entities. Ticks are 20 Hz; `tick16` means the low 16 bits of the server tick.
 *
 * # Client → server: `MSG_INPUT` (send-on-change, at most 10 Hz, two 20 Hz frames per message)
 *
 * The client numbers one frame per 20 Hz tick. At each 10 Hz slot it sends that slot's two frames
 * **only if either differs** from the last frame sent (stick, aim quantised to 1/1024 turn, or
 * buttons), and otherwise stays silent, apart from a one-frame keepalive every 500 ms.
 * **Silence means "unchanged"**: the server re-applies the last frame for every frame number it
 * wasn't sent, exactly as the client predicted. Use `InputBatcher` / `InputQueue` in
 * `ffa/sim/input.ts`; they implement both ends of this rule.
 *
 * | Offset | Type | Field |
 * |---|---|---|
 * | 0 | u8 | `MSG_INPUT` |
 * | 1 | u16 | `seq` of the first frame (wraps; frame i has seq + i) |
 * | 3 | u8 | frame count `n` (1–4, normally 2) |
 * | 4 | u16 | `ackTick`: tick16 of the newest snapshot received |
 * | 6 | u8 | `ackAgeMs`: ms between receiving that snapshot and sending this message (cap 255) |
 * | 7 | n × 9 B | frames |
 *
 * Frame (9 B): `moveX i8`, `moveZ i8` (−127..127, normalised on the server), `aim u16` (turns,
 * 0 = +x, increasing toward +z), `buttons u16` (`BTN_*`, held state; the server edge-detects),
 * `viewTick u16` (tick16 of the remote-entity time the client was rendering), `viewFrac u8`
 * (fraction of a tick ×255). The view time is used only to rewind hits, clamped to `MAX_REWIND_MS`.
 *
 * # Server → client: `MSG_SNAPSHOT` (20 Hz)
 *
 * | Section | Layout |
 * |---|---|
 * | Header (11 B) | `u8 MSG_SNAPSHOT`, `u32 tick`, `u16 lastInputSeq`, `i8 inputLead`, `u8 flags` (`SNAP_*`), `u8 entityCount`, `u8 removedCount` |
 * | Self (41 B) | `u16 x`, `u16 z`, `u8 hp`, `u8 ammo`, `u8 selfFlags` (`SELF_*`), `u8 rollTicks`, `u8 rollCooldown`, `u16 rollDir`, `u8 reloadTicks`, `u8 fireCooldown` (ms ÷ 4), `u8 protectTicks`, `u8 deadEyeTicks`, `u8 channelKind` (`CHANNEL_*`), `u8 channelTicks`, `u32 carried`, `u8 respawnTicks`, `u8 holsterTicks`, `u16 lastButtons`, `u8 weapon` (`selfWeapon()`: bits 0–1 `WEAPON_*`, bits 2–4 pickup-weapon rounds, bit 5 holding dynamite; 0 = plain revolver), `u8 jumpTicks`, `u8 jumpCooldown`, `u8 vaultStep` (cm per tick; 0 = a hop), `u16 vaultAim`, `u8 moveFlags` (`MOVE_*`), `u8 sprintLock`, `u8 sprintOut`, `u8 slideTicks`, `u8 slideCooldown`, `u16 slideAim`, `i8 airX`, `i8 airZ` (cm per tick) |
 * | Removed | `removedCount × u8 id` (left interest or left the lobby) |
 * | Entities | `entityCount ×` entity record |
 * | Town (if `SNAP_TOWN`) | `u8 mostWantedId` (255 none), `u8 mwX`, `u8 mwZ` (0.6 m units), `u8 strongboxSpot` (255 none), `u16 strongboxValue`, `u8 strongboxState` (`BOX_*`), `u8 players`, `u32 banked` (this player's wallet, as last confirmed) |
 * | Events | `u8 count`, then `count ×` (`u8 EV_*`, payload; sizes in `EVENT_SIZES`) |
 *
 * `inputLead` is how early this player's input arrived: the smallest, over the input messages that
 * came in since the previous snapshot, of (first frame's seq − the seq the next tick will consume),
 * clamped to −127..127; `INPUT_LEAD_NONE` when none came in. Negative means a frame arrived after
 * its number was consumed (the server repeated the previous frame in its place). The client paces
 * its input ticks to hold it at 1–3 (`ffa/client/tick-clock.ts`).
 *
 * Entity record: `u8 id`, `u8 mask` (`ENT_*`), then the fields whose bits are set, in bit order:
 * `ENT_POS` → `i8 dx, i8 dz` against the last sent position, or with `ENT_POS_FULL` → `u16 x, u16 z`;
 * `ENT_AIM` → `u8 aim`; `ENT_HP` → `u8 hp`; `ENT_FLAGS` → `u8 flags` (`EF_*`); `ENT_ANIM` → `u8 anim`
 * (`ANIM_*`); `ENT_CARRY` → `u8 carryTier`. An entity entering interest sends every field with
 * `ENT_POS_FULL` (9–10 B); a steady one sends 2–6 B. Entities 40–60 m away are refreshed every other
 * tick; beyond 60 m they are removed (the Most Wanted star rides in the town section instead).
 *
 * # Map pickups (server-authoritative)
 *
 * The spots are `pickups` in `town.layout.json` (event `spot` = index in that array). Every spot
 * starts available; walking within 1.2 m takes it, and it respawns 45 s later (`EV_PICKUP_TAKEN`,
 * then `EV_PICKUP_READY`). A full snapshot replays `EV_PICKUP_TAKEN` (player 255) for every spot
 * that's currently gone, and `EV_DYNAMITE_THROWN` for every lit fuse.
 * - Shotgun: 2 shells, 8 pellets × 12 damage, 9 m, 700 ms between shells. One `EV_SHOT` per shell
 *   with `SHOT_SHOTGUN` (target = the player hit hardest).
 * - Rifle: 5 rounds, 60 damage, 35 m, 900 ms bolt. `EV_SHOT` with `SHOT_RIFLE`.
 * - Dynamite (×1): `BTN_THROW` lobs it up to 10 m along your aim (stopped by walls); 2 s fuse, then
 *   80 damage to everyone within 4 m with no wall in between, including the thrower.
 * A pickup weapon replaces the gun in your hand until its rounds run out (then back to the
 * revolver, which keeps its own six); Dead-Eye is revolver-only. Dying drops nothing extra: pickup
 * weapons and dynamite are simply lost.
 *
 * # Server → client: `MSG_FULL_RESET`
 *
 * One byte. The next snapshot is a full snapshot; the client must drop its delta baseline. Sent on
 * reconnect before the first snapshot.
 */
import { reopensOn } from '../data/sinks.ts'

/**
 * 2: `EV_BAG_DROP` carries the dropper's saddlebag `style`.
 * 3: input frames carry `buttons u16`; snapshots carry `inputLead i8` in the header and
 *    `lastButtons u16` in the self block. Clients send `wire` in `POST /town/join`; an older client
 *    (no `wire`, or a smaller one) is refused with `outdated`.
 * 4: `BTN_JUMP` (vault / hop); the self block carries the jump state; `ANIM_VAULT`, `ANIM_HOP`.
 * 5: CoD movement: `BTN_SPRINT`, `BTN_CROUCH` (slide from a sprint), `BTN_AIM` held slows you and
 *    tightens the spread; the self block grows by 9 bytes (`u8 moveFlags` (`MOVE_*`),
 *    `u8 sprintLock`, `u8 sprintOut`, `u8 slideTicks`, `u8 slideCooldown`, `u16 slideAim`,
 *    `i8 airX`, `i8 airZ` (cm per tick)); an entity's `anim` byte carries `ANIM_*` in its low
 *    nibble and the stance bits (`STANCE_*`) above it; `ANIM_SLIDE`.
 */
export const CONTRACT_VERSION = 5
/** The binary Frontier wire format this build speaks (`TownJoinRequest.wire`). */
export const TOWN_WIRE_VERSION = 5

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

export type ClientControl =
  /** Showdown draw. `localMs` is the reaction measured on the client from the call it heard. */
  | { type: 'showdown_shot'; showdownId: number; localMs: number | null }
  /** Graceful leave without the 5 s channel (counts as a disconnect: carry drops). */
  | { type: 'bye' }

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
export const INPUT_FRAME_BYTES = 9
export const MAX_FRAMES_PER_INPUT = 4
export const SNAPSHOT_HEADER_BYTES = 11
export const SNAPSHOT_SELF_BYTES = 41
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

/** `u8 shooter, u16 aim (with spread), u8 rangeQ (× SHOT_RANGE_UNIT m), u8 target (255 none), u8 flags (SHOT_*)` */
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

export const EVENT_SIZES: Readonly<Record<number, number>> = {
  [EV_SHOT]: 6,
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
}

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
  return `Perdition is closed for the rest of the month. It reopens on ${reopensOn(now)} (UTC). Quick Draw is still open.`
}
