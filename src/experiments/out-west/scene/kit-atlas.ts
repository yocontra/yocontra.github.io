/**
 * The prop/building trim atlas (`tex/kit_*.webp`, built by `tools/build-props.ts`): the
 * Quaternius kits' trim sheets stacked in horizontal bands. Their UVs tile along U, so the atlas
 * repeats along U and clamps along V; each band keeps a gutter of copied edge rows so mips don't
 * bleed between sheets. Rows are albedo pixels (normal and ARM are half size).
 */

export const KIT_W = 1024
export const KIT_H = 3648
export const KIT_INSET = 8

export type KitBand = 'wood' | 'furniture' | 'metal' | 'props' | 'ornament' | 'cloth' | 'plain'

export const KIT_BAND: Record<KitBand, { y: number; h: number }> = {
  wood: { y: 0, h: 1024 },
  furniture: { y: 1024, h: 1024 },
  metal: { y: 2048, h: 512 },
  props: { y: 2560, h: 512 },
  ornament: { y: 3072, h: 256 },
  cloth: { y: 3328, h: 256 },
  plain: { y: 3584, h: 64 },
}
