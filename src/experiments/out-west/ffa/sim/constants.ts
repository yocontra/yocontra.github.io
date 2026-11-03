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
