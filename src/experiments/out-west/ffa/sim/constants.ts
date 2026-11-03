/**
 * Frontier simulation constants. The `ffa/sim/` folder is pure, deterministic code shared by the
 * Lobby Durable Object and the client's prediction. Owned by stream F; the client (G) reads it only.
 */
export const TICK_HZ = 20
/** Clients batch input frames and send at this rate (two frames per message) to halve billing. */
export const INPUT_SEND_HZ = 10
export const MAX_PLAYERS = 32
