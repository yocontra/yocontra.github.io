/**
 * Viewport CSS variables (spec §11.1), set on `<html>`:
 *
 * - `--sai-top|right|bottom|left`: the safe-area insets in px. Read from `env(safe-area-inset-*)`
 *   (needs `viewport-fit=cover`), or pushed by the native bridge, which wins.
 * - `--app-h`: the usable height. `100dvh` where supported, else `100svh`, else the measured
 *   `visualViewport` height in px (old iOS). Use `height: var(--app-h, 100dvh)` on the root.
 *
 * Keep the HUD out of the home-indicator zone with `padding-bottom: max(12px, var(--sai-bottom))`.
 * Owned by stream A.
 */
import { type Insets, nativeSafeArea } from './bridge.ts'

const SIDES = ['top', 'right', 'bottom', 'left'] as const
/** `--ow-sai-*` suffixes (tokens.css). */
const SHORT = { top: 't', right: 'r', bottom: 'b', left: 'l' } as const

/** Measures `env(safe-area-inset-*)` with an off-screen probe. */
function measureEnvInsets(): Insets {
  const probe = document.createElement('div')
  probe.style.cssText = [
    'position:fixed',
    'visibility:hidden',
    'pointer-events:none',
    ...SIDES.map((s) => `padding-${s}:env(safe-area-inset-${s},0px)`),
  ].join(';')
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const insets: Insets = {
    top: Number.parseFloat(cs.paddingTop) || 0,
    right: Number.parseFloat(cs.paddingRight) || 0,
    bottom: Number.parseFloat(cs.paddingBottom) || 0,
    left: Number.parseFloat(cs.paddingLeft) || 0,
  }
  probe.remove()
  return insets
}

function heightValue(): string {
  if (CSS.supports('height', '100dvh')) {
    return '100dvh'
  }
  if (CSS.supports('height', '100svh')) {
    return '100svh'
  }
  return `${Math.round(globalThis.visualViewport?.height ?? globalThis.innerHeight)}px`
}

/** Writes the variables once. */
export function applyViewportVars(root: HTMLElement = document.documentElement): Insets {
  const native = nativeSafeArea()
  const insets = native ?? measureEnvInsets()
  for (const side of SIDES) {
    root.style.setProperty(`--sai-${side}`, `${insets[side]}px`)
    // The UI reads `--ow-sai-*` (tokens.css: live `env()`). A native push wins over `env()`, which
    // is 0 in a WebView that isn't edge-to-edge (older Android WebViews, an inset-adjusted
    // WKWebView); without one, the live `env()` stays in charge.
    const ow = `--ow-sai-${SHORT[side]}`
    if (native) {
      root.style.setProperty(ow, `${native[side]}px`)
    } else {
      root.style.removeProperty(ow)
    }
  }
  root.style.setProperty('--app-h', heightValue())
  return insets
}

/**
 * Keeps the variables current across rotation, keyboard and toolbar changes, and native pushes.
 * Returns a dispose function.
 */
export function installViewportVars(root: HTMLElement = document.documentElement): () => void {
  let frame = 0
  const update = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => applyViewportVars(root))
  }
  applyViewportVars(root)
  const targets: [EventTarget | undefined, string][] = [
    [globalThis, 'resize'],
    [globalThis, 'orientationchange'],
    [globalThis, 'ow-safe-area'],
    [globalThis.visualViewport ?? undefined, 'resize'],
  ]
  for (const [t, ev] of targets) {
    t?.addEventListener(ev, update)
  }
  return () => {
    cancelAnimationFrame(frame)
    for (const [t, ev] of targets) {
      t?.removeEventListener(ev, update)
    }
  }
}
