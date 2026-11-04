/**
 * Frontier simulation constants. The `ffa/sim/` folder is pure, deterministic code shared by the
 * Lobby Durable Object and the client's prediction. Owned by stream F; the client (G) reads it only.
 *
 * Durations are in ticks (20 Hz, 50 ms) unless the name says otherwise.
 */
export const TICK_HZ = 20
export const TICK_MS = 1000 / TICK_HZ
export const DT = 1 / TICK_HZ
/** Clients batch input frames and send at this rate (two frames per message) to halve billing. */
export const INPUT_SEND_HZ = 10
export const FRAMES_PER_INPUT = TICK_HZ / INPUT_SEND_HZ
export const MAX_PLAYERS = 32
/** The directory fills a lobby to this many; slots above are for rejoins and late fills. */
export const SOFT_CAP = 28

const s = (seconds: number): number => Math.round(seconds * TICK_HZ)

// --- Movement -----------------------------------------------------------------------------------

export const RUN_SPEED = 5.5
export const PLAYER_RADIUS = 0.4
export const ROLL_TICKS = s(0.35)
export const ROLL_DISTANCE = 4
export const ROLL_SPEED = ROLL_DISTANCE / (ROLL_TICKS * DT)
export const ROLL_IFRAME_TICKS = s(0.25)
export const ROLL_COOLDOWN_TICKS = s(2.5)
/**
 * Jump (`BTN_JUMP`): facing low cover with a `vaultHeight` within `VAULT_REACH` of you, a committed
 * 0.5 s vault over it to the first clear spot beyond (at most `VAULT_MAX_M` of travel, never through
 * anything solid); anywhere else a small hop in place that changes nothing. No shooting mid-vault, no
 * i-frames (the roll is the dodge). Either one starts `JUMP_COOLDOWN_TICKS`.
 */
export const VAULT_TICKS = s(0.5)
export const VAULT_REACH = 1
export const VAULT_MAX_M = 4
export const HOP_TICKS = s(0.55)
export const JUMP_COOLDOWN_TICKS = s(0.7)
/** In the air you keep your take-off velocity, steering this fraction toward the stick a tick. */
export const AIR_CONTROL = 0.12

// --- CoD movement (wire v5) -----------------------------------------------------------------------

/** Sprint (`BTN_SPRINT` held, the stick within `SPRINT_CONE_DEG` of your aim, half a stick or more). */
export const SPRINT_SPEED = 7.6
export const SPRINT_CONE_DEG = 50
export const SPRINT_MIN_STICK = 0.5
/** A trigger pull ends the sprint; the gun is up (and the shot goes) this many ticks later. */
export const SPRINT_OUT_TICKS = s(0.15)
/** No sprint for this long after a trigger pull (or while the trigger is held). */
export const SPRINT_LOCK_TICKS = s(0.4)
/** Crouched (`BTN_CROUCH` held). */
export const CROUCH_SPEED = 2.9
/** On the sights (`BTN_AIM` held) your feet slow to this fraction. */
export const ADS_SPEED_FACTOR = 0.55
/**
 * Slide: crouch pressed mid-sprint. `SLIDE_TICKS` along the sprint's heading, easing from
 * `SLIDE_SPEED` to `SLIDE_END_SPEED` (about 4.4 m). The first `SLIDE_IFRAME_TICKS` dodge bullets
 * like the roll did. You can shoot from a slide (at a wider spread).
 */
export const SLIDE_TICKS = s(0.65)
export const SLIDE_SPEED = 9.5
export const SLIDE_END_SPEED = 4
export const SLIDE_IFRAME_TICKS = s(0.25)
export const SLIDE_COOLDOWN_TICKS = s(1.6)

// --- Health -------------------------------------------------------------------------------------

export const MAX_HP = 100
export const REGEN_DELAY_TICKS = s(5)
export const REGEN_PER_TICK = 12 / TICK_HZ
export const DEATH_CAM_TICKS = s(3)
export const SPAWN_PROTECT_TICKS = s(3)
/** Killed this soon after spawning: the Sheriff's pardon. */
export const PARDON_TICKS = s(8)
export const SPAWN_MIN_ENEMY_DIST = 25
export const SPAWN_LOS_DIST = 35
/** No spawn point within this distance of the bank. */
export const SPAWN_BANK_CLEARANCE = 30

// --- Revolver -----------------------------------------------------------------------------------

export const REVOLVER_ROUNDS = 6
export const REVOLVER_DAMAGE = 34
export const REVOLVER_FIRE_MS = 280
export const RELOAD_TICKS = s(1.6)
export const FALLOFF_RANGE = 14
export const FALLOFF_FACTOR = 0.6
export const MAX_RANGE = 22
export const SPREAD_STANDING_DEG = 1.5
export const SPREAD_MOVING_DEG = 4
/**
 * Hip fire versus the sights (wire v5): each gun's spread from the hip and on the sights, scaled
 * by how you move (`SPREAD_*_K`), plus bloom: every shot adds `*_BLOOM_DEG` (halved on the sights)
 * up to `MAX_BLOOM_DEG`, and it settles at `BLOOM_DECAY_DEG` a tick.
 */
export const REVOLVER_HIP_DEG = 2.2
export const REVOLVER_ADS_DEG = 0.35
export const REVOLVER_BLOOM_DEG = 1.2
export const RIFLE_HIP_DEG = 4
export const RIFLE_ADS_DEG = 0.15
export const RIFLE_BLOOM_DEG = 2.5
/** The shotgun's cone (full width) on the sights; `SHOTGUN_CONE_DEG` from the hip. */
export const SHOTGUN_ADS_CONE_DEG = 8
export const MAX_BLOOM_DEG = 5
export const BLOOM_DECAY_DEG = 0.3
export const SPREAD_MOVING_K = 1.6
export const SPREAD_CROUCH_K = 0.7
export const SPREAD_SLIDE_K = 1.8
export const SPREAD_AIR_K = 2.5
/** Extra degrees in the air (a jump shot is a gamble). */
export const SPREAD_AIR_DEG = 3

// --- Map pickups (§3.2: equal-access, fixed spots, 45 s respawn) ------------------------------------

export const PICKUP_RESPAWN_TICKS = s(45)
export const PICKUP_RADIUS = 1.2
export const SHOTGUN_SHELLS = 2
export const SHOTGUN_PELLETS = 8
export const SHOTGUN_PELLET_DAMAGE = 12
export const SHOTGUN_RANGE = 9
/** Full cone width of the pellet pattern. */
export const SHOTGUN_CONE_DEG = 12
export const SHOTGUN_FIRE_MS = 700
export const RIFLE_ROUNDS = 5
export const RIFLE_DAMAGE = 60
export const RIFLE_RANGE = 35
export const RIFLE_FIRE_MS = 900
export const RIFLE_SPREAD_STANDING_DEG = 0.4
export const RIFLE_SPREAD_MOVING_DEG = 3
export const DYNAMITE_FUSE_TICKS = s(2)
export const DYNAMITE_RADIUS = 4
export const DYNAMITE_DAMAGE = 80
export const DYNAMITE_THROW_RANGE = 10

// --- Dead-Eye -----------------------------------------------------------------------------------

export const HOLSTER_TICKS = s(1.5)
export const DEAD_EYE_CLOSE_TICKS = s(0.4)
export const DEAD_EYE_WINDOW_TICKS = s(0.15)
export const DEAD_EYE_MULTIPLIER = 2

// --- Money --------------------------------------------------------------------------------------

export const BAG_PICKUP_RADIUS = 1.2
export const BAG_EXCLUSIVE_TICKS = s(2)
export const BAG_EXPIRE_TICKS = s(45)
export const BANK_CHANNEL_TICKS = s(2)
export const STAGE_CHANNEL_TICKS = s(4)
export const LEAVE_CHANNEL_TICKS = s(5)
export const MOST_WANTED_MIN = 300
export const MOST_WANTED_REFRESH_TICKS = s(2)
export const STRONGBOX_INTERVAL_TICKS = s(180)
export const STRONGBOX_FIRST_TICKS = s(60)
export const STRONGBOX_CHANNEL_TICKS = s(3)
export const STRONGBOX_RADIUS = 1.8
/** Kills of the same victim within this window: the 4th and later pay nothing. */
export const FARM_WINDOW_TICKS = s(600)
export const FARM_FREE_KILLS = 3
export const ASSIST_DAMAGE = 30
export const ASSIST_WINDOW_TICKS = s(5)
/** A disconnected avatar stands still and vulnerable this long before its carry drops. */
export const LINGER_TICKS = s(10)

// --- Call Out -----------------------------------------------------------------------------------

export const CALLOUT_RANGE = 12
export const CALLOUT_CONE_DEG = 35
export const CALLOUT_CALM_TICKS = s(3)
export const CALLOUT_MIN_CARRY = 50
export const CALLOUT_COOLDOWN_TICKS = s(30)
export const CALLOUT_ACCEPT_TICKS = s(3)
export const SHOWDOWN_MAX_TICKS = s(6)
export const SHOWDOWN_WAIT_MIN_TICKS = s(1.5)
export const SHOWDOWN_WAIT_MAX_TICKS = s(3.5)
export const SHOWDOWN_JUDGE_TICKS = s(1.5)
export const SHOWDOWN_FAKE_CUES = 9

// --- Network ------------------------------------------------------------------------------------

/** Ticks of position history kept for lag compensation (800 ms). */
export const HISTORY_TICKS = 16
/** Interest radius: full rate inside, half rate out to the far radius, nothing beyond. */
export const INTEREST_NEAR = 40
export const INTEREST_FAR = 60
/** Inputs buffered ahead of the tick; extra frames are dropped (their button presses are kept). */
export const MAX_BUFFERED_FRAMES = 4
export const MAX_INPUT_MSGS_PER_SEC = 40
