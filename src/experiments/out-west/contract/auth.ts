/**
 * HTTP and token types for accounts, passkeys and app handoff.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream A.
 */
export const CONTRACT_VERSION = 1
