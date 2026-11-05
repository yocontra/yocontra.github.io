/**
 * Shared building rules: door and window dimensions the scene builder and the building audit both
 * read. Pure constants and arithmetic, so `tools/building-audit.ts` can check the layout without a
 * browser or a renderer.
 */

/** Wall thickness, metres (matches the collision grid). */
export const WALL_T = 0.5
/** Doorways wider than this get a taller lintel. */
export const WIDE_DOOR = 3.2
/** Top of a normal doorway, metres. */
export const DOOR_TOP = 2.45
/** Door frame members, metres. */
export const DOOR_JAMB = 0.16
export const DOOR_HEAD = 0.22
export const DOOR_FRAME_DEPTH = WALL_T + 0.12

/** Top of a doorway: wide barn/forge openings get a taller lintel. */
export const doorTop = (width: number): number => DOOR_TOP + (width > WIDE_DOOR ? 0.5 : 0)

/** Window geometry, shared by the kit placement and the interior duplicates. */
export const WINDOW_SILL = 0.85
export const STOREY_H = 3.2
export const WINDOW_SASH = 0.97
export const WINDOW_SCALE = 1.3
export const SHOP_WINDOW_SCALE = 1.35
export const WINDOW_LIFT = 0.05
/** The native kit's top above its origin, metres. */
export const WINDOW_KIT_TOP = 2.533
/** The native kit's sash height above its origin, metres. */
export const WINDOW_KIT_SASH = 0.975

/** Visible bottom of a kit window placed at `sill` with scale `s`. */
export const windowBottom = (sill: number, s: number): number =>
  sill - WINDOW_SASH * s + WINDOW_LIFT + WINDOW_KIT_SASH * s

/** Visible top of a kit window placed at `sill` with scale `s`. */
export const windowTop = (sill: number, s: number): number =>
  sill - WINDOW_SASH * s + WINDOW_LIFT + WINDOW_KIT_TOP * s
