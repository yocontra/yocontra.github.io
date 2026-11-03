/**
 * Frontier HTTP types, JSON control messages, and the binary snapshot/input codec spec.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream F.
 */
export const CONTRACT_VERSION = 1
