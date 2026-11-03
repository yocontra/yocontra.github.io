/**
 * Bounty Hunt HTTP and WebSocket message types (queue, match, duel room).
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream B.
 */
export const CONTRACT_VERSION = 1
