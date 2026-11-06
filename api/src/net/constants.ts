/**
 * Timing shared by the API's Durable Objects. These values must agree across the ranked, Daily and
 * Frontier sockets: a client pings once, and every room measures it the same way.
 */

/** Heartbeat interval on every game socket, ms. */
export const PING_INTERVAL_MS = 400

/** RTT samples kept per player; older samples roll off. */
export const RTT_SAMPLES = 12

/** How long a player may stay away from a ranked queue before the match is forfeited. */
export const DODGE_WINDOW_MS = 10 * 60 * 1000
