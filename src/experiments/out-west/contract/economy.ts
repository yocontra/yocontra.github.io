/**
 * Wallet, ledger, XP, catalog and store request/response types.
 * Shared by the browser and the Worker, so it must stay pure TypeScript: no DOM, no Workers types,
 * no imports outside `contract/` and `data/`. Owned by stream C.
 */
export const CONTRACT_VERSION = 1
