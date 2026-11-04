/**
 * The viewport size, cached. Reading `innerWidth` / `innerHeight` after the HUD has written to the
 * DOM forces a synchronous layout; the per-frame HUD (crosshair, edge arrows, bank guide) reads
 * this instead, refreshed on resize.
 */
export const viewport = { w: 1, h: 1 }

function measure(): void {
  viewport.w = globalThis.innerWidth || 1
  viewport.h = globalThis.innerHeight || 1
}

if (typeof globalThis.addEventListener === 'function') {
  measure()
  globalThis.addEventListener('resize', measure)
  globalThis.addEventListener('orientationchange', measure)
}
