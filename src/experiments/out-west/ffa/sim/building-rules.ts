/**
 * Shared building rules: door and window dimensions the scene builder, the layout generator, the
 * collision grid and the building audit all read. Pure constants and arithmetic, no renderer.
 */
import type { Building, Side, TownLayout } from './layout.ts'

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

/** Where a pane sits inside a real wall opening. */
export const WINDOW_PANE_INSET = WALL_T / 2
/** Inset of the pane from the opening's edges, metres. */
export const WINDOW_PANE_MARGIN = 0.03
/** A solid building has no cut wall: its pane sits this far proud of the face (inside the float audit's 2 cm wall tolerance). */
export const WINDOW_FACE_PROUD = 0.015
/** Smallest pane dimension, metres. */
export const WINDOW_PANE_MIN = 0.1
/** The proud casing/sill depth and width, metres. */
export const WINDOW_TRIM_PROUD = 0.075
export const WINDOW_TRIM_WIDTH = 0.11
export const WINDOW_TRIM_THICKNESS = 0.08
/** The sill/lintel run past the opening on each side, metres. */
export const WINDOW_TRIM_OVERHANG = 0.16
/** A mullion's thickness, metres. */
export const WINDOW_MULLION = 0.05
/** Openings at least this tall get a horizontal meeting rail between the sashes. */
export const WINDOW_MEETING_MIN = 0.9

/** Glass material, one for every pane. */
export const WINDOW_GLASS_COLOR = 0x8a_a2_ac
export const WINDOW_GLASS_OPACITY = 0.24
export const WINDOW_GLASS_ROUGHNESS = 0.12
export const WINDOW_GLASS_METALNESS = 0.18

/** Buildings whose ground floor gets display windows on the street face. */
export const SHOPFRONT: ReadonlySet<string> = new Set([
  'saloon',
  'hotel',
  'general_store',
  'stage_line',
  'assay',
  'undertaker',
  'bank',
  'jail',
])

/** One real opening in a wall: the scene cuts the wall, the sim sees/fires through it. */
export interface WindowOpening {
  id: string
  side: Side
  /** Offset along the wall from its west/north end, metres. */
  at: number
  width: number
  /** Opening bottom/top, metres. */
  sill: number
  top: number
  /** Floor index, 0 for the ground floor. */
  floor: number
  /** Kit scale used for shutters and the pane proportions. */
  scale: number
  shop: boolean
}

/** Where a window's glass sits: one axis-aligned plane shared by the scene and the sim. */
export interface PanePlacement {
  /** 0 for a plane of constant x (east/west walls), 1 for constant z (north/south). */
  axis: 0 | 1
  /** Plane coordinate on that axis, metres. */
  at: number
  /** Opening extent along the other horizontal axis, metres. */
  a0: number
  a1: number
  /** Opening bottom/top, metres. */
  y0: number
  y1: number
}

/** A pane plus its index into `World.glass`. */
export interface GlassPlane extends PanePlacement {
  index: number
}

/** The glass plane for `w` on `b`: inside a real cut wall, proud of a solid block's face. */
export function windowPane(b: Building, w: WindowOpening): PanePlacement {
  const along0 = b.x + w.at
  const along1 = along0 + w.width
  const across0 = b.z + w.at
  const across1 = across0 + w.width
  switch (w.side) {
    case 'e':
      return {
        axis: 0,
        at: b.x + b.w + (b.hollow ? -WINDOW_PANE_INSET : WINDOW_FACE_PROUD),
        a0: across0,
        a1: across1,
        y0: w.sill,
        y1: w.top,
      }
    case 'w':
      return {
        axis: 0,
        at: b.x + (b.hollow ? WINDOW_PANE_INSET : -WINDOW_FACE_PROUD),
        a0: across0,
        a1: across1,
        y0: w.sill,
        y1: w.top,
      }
    case 'n':
      return {
        axis: 1,
        at: b.z + (b.hollow ? WINDOW_PANE_INSET : -WINDOW_FACE_PROUD),
        a0: along0,
        a1: along1,
        y0: w.sill,
        y1: w.top,
      }
    default:
      return {
        axis: 1,
        at: b.z + b.d + (b.hollow ? -WINDOW_PANE_INSET : WINDOW_FACE_PROUD),
        a0: along0,
        a1: along1,
        y0: w.sill,
        y1: w.top,
      }
  }
}

/** Every opening in town, in one stable order the scene and the sim both index by. */
export function townWindows(
  layout: TownLayout,
): { b: Building; w: WindowOpening; index: number }[] {
  const out: { b: Building; w: WindowOpening; index: number }[] = []
  for (const b of layout.buildings) {
    for (const w of b.windows ?? []) {
      out.push({ b, w, index: out.length })
    }
  }
  return out
}

/** Every window slot on a building's four sides, exactly where the scene draws them. */
export function windowSlots(b: Building, front: Side): WindowOpening[] {
  const out: WindowOpening[] = []
  for (const side of ['n', 's', 'e', 'w'] as const) {
    const len = side === 'n' || side === 's' ? b.w : b.d
    const doors = b.doors.filter((d) => d.side === side)
    for (let f = 0; f < b.floors; f++) {
      const sill = WINDOW_SILL + f * STOREY_H
      const shop = f === 0 && side === front && SHOPFRONT.has(b.kind)
      const step = shop ? 3.8 : 3
      const span = shop ? 2 : 1.3
      const scale = shop ? SHOP_WINDOW_SCALE : WINDOW_SCALE
      for (let a = 1.2; a + span < len - 0.7; a += step) {
        if (f === 0 && doors.some((d) => a + span > d.at - 0.7 && a < d.at + d.width + 0.7)) {
          continue
        }
        out.push({
          id: `${b.id}:${side}:${f}:${a.toFixed(2)}`,
          side,
          at: a,
          width: span,
          sill: windowBottom(sill, scale),
          top: windowTop(sill, scale),
          floor: f,
          scale,
          shop,
        })
      }
    }
  }
  return out
}
