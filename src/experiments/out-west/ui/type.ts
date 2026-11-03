/**
 * The out west type system. Four self-hosted faces (fontsource, latin subsets; nothing from a CDN,
 * so the game works offline in a WebView), each with one job:
 *
 * | Role      | Face                     | Used for                                                     |
 * |-----------|--------------------------|--------------------------------------------------------------|
 * | display   | Ultra (fat-face Clarendon wood type) | WANTED, screen titles, DRAW!, bounties on posters |
 * | ornate    | Rye (Tuscan wood type)   | The wordmark, the saloon sign, "Dead or alive", VS. Sparingly |
 * | text      | EB Garamond (variable 400–800, real small caps, old-style + lining figures) | body copy, labels and buttons in small caps |
 * | numerals  | Oswald (variable 200–700, condensed Alternate Gothic) | HUD money, timers, XP, levels: tabular |
 *
 * The scale is a major third (×1.25) on a 16 px base, snapped to whole pixels; every size in the UI
 * comes from `TYPE_SCALE` (mirrored as `--ow-fs-*` in tokens.css). Nothing below 13 px ships, so
 * text stays legible on a 390 × 844 phone. Letter-spacing: display +0.02em, small-caps labels
 * +0.1em, body 0. Money, timers and XP always use tabular lining figures.
 *
 * tokens.css declares the @font-face rules (via @import of the fontsource CSS), the CSS custom
 * properties and the role classes (`.ow-t-*`). The Frontier HUD (and anything else) reuses all of it
 * by importing tokens.css and these stacks.
 */
/** CSS font stacks (the fallbacks are metric-close system faces, only for a failed load). */
export const FONT = {
  display: '"Ultra", "Rockwell Extra Bold", Rockwell, Georgia, serif',
  ornate: '"Rye", "Ultra", Georgia, serif',
  text: '"EB Garamond Variable", Garamond, "Iowan Old Style", Georgia, serif',
  num: '"Oswald Variable", "Arial Narrow", "Helvetica Neue", sans-serif',
} as const

/** Pixel sizes of the scale (1rem = 16 px). */
export const TYPE_SCALE = {
  micro: 13,
  small: 14,
  body: 16,
  lead: 18,
  h4: 20,
  h3: 24,
  h2: 32,
  h1: 40,
  display: 64,
  hero: 96,
} as const

export type TypeStep = keyof typeof TYPE_SCALE

/** A canvas `font` shorthand for a role at a pixel size (posters and painted signs). */
export function canvasFont(
  role: keyof typeof FONT,
  px: number,
  o: { weight?: number; italic?: boolean } = {},
): string {
  const style = o.italic ? 'italic ' : ''
  const weight = o.weight ?? (role === 'text' ? 500 : 400)
  return `${style}${weight} ${Math.round(px)}px ${FONT[role]}`
}

/** One probe per face and style the canvas painters need before they draw. */
const PROBES = [
  '400 32px "Ultra"',
  '400 32px "Rye"',
  '500 32px "EB Garamond Variable"',
  'italic 500 32px "EB Garamond Variable"',
  '600 32px "EB Garamond Variable"',
  '500 32px "Oswald Variable"',
] as const

let loading: Promise<void> | null = null

/**
 * Resolves when every face is loaded (or after `timeoutMs`, so a broken font never blocks the
 * game). Canvas text (wanted posters, signs) must wait for this: canvas never swaps fonts later.
 */
export function loadFonts(timeoutMs = 4000): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    return Promise.resolve()
  }
  loading ??= Promise.race([
    Promise.all(PROBES.map((p) => document.fonts.load(p, 'WANTED $0'))).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs)
    }),
  ]).catch(() => undefined)
  return loading
}

/** True once every face reports loaded. */
export function fontsReady(): boolean {
  return PROBES.every((p) => document.fonts.check(p, 'W'))
}
