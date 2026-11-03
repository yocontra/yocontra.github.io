/**
 * The shared character atlas (`tex/char_*.webp`, built by `tools/build-characters.ts`).
 *
 * Every character draws with ONE material, so every texture it needs lives in one atlas: the
 * two outfit sets, the two face/skin sets, the hand skins, hair, eyes, and a strip of small
 * fabric swatches for the procedural garments (coats, ponchos, hats, bandanas...). Rects are in
 * pixels of the albedo (the normal and ARM maps are the same layout at half size), origin top
 * left, the way glTF UVs are.
 */

export const ATLAS_W = 2048
export const ATLAS_H = 3072

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

/** Source texture regions. */
export const REGION = {
  ranger: r(0, 0, 1024, 1024),
  peasant: r(1024, 0, 1024, 1024),
  skinM: r(0, 1024, 1024, 1024),
  skinF: r(1024, 1024, 1024, 1024),
  handsM: r(0, 2048, 512, 512),
  handsF: r(512, 2048, 512, 512),
  hair1: r(1024, 2048, 512, 512),
  hair2: r(1536, 2048, 512, 512),
  eyes: r(0, 2560, 256, 256),
} as const

/** Fabric swatches the procedural garments are mapped onto (once, not tiled). */
export type Swatch = 'leather' | 'wool' | 'felt' | 'linen' | 'hessian' | 'metal' | 'plain'

export const SWATCH: Record<Swatch, Rect> = {
  leather: r(256, 2560, 256, 256),
  wool: r(512, 2560, 256, 256),
  felt: r(768, 2560, 256, 256),
  linen: r(1024, 2560, 256, 256),
  hessian: r(1280, 2560, 256, 256),
  metal: r(1536, 2560, 256, 256),
  plain: r(1792, 2560, 256, 256),
}

/**
 * Mean linear luminance of each swatch's albedo: the recolour divides by it, so a tint is the
 * garment's average colour and the weave only modulates it.
 */
export const SWATCH_LUM: Record<Swatch, number> = {
  leather: 0.037,
  wool: 0.226,
  felt: 0.094,
  linen: 0.398,
  hessian: 0.2,
  metal: 0.58,
  plain: 1,
}

/** Gutter kept inside each rect so mip levels don't bleed between neighbours. */
export const INSET = 6

/** Map a 0..1 UV into a rect of the atlas (inset by the gutter), as atlas UVs. */
export function intoRect(rect: Rect, u: number, v: number): [number, number] {
  const x = rect.x + INSET + u * (rect.w - 2 * INSET)
  const y = rect.y + INSET + v * (rect.h - 2 * INSET)
  return [x / ATLAS_W, y / ATLAS_H]
}
