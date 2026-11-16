/** One offline raster/UV contract. All sixteen non-short rows keep their original rectangles. */
export const SIGN_ATLAS_WIDTH = 2048
export const SIGN_ATLAS_HEIGHT = 3584
export const SIGN_GUTTER = 16
export const SIGN_SHORT_BAND = { left: 0, top: 1536, width: 2048, height: 1536 } as const

export function signRect(row: number) {
  if (!Number.isInteger(row) || row < 0 || row >= 28) {
    throw new Error('Expected sign row 0..27')
  }
  if (row < 12 || row >= 24) {
    return { left: 0, top: row * 128, width: 2048, height: 128 }
  }
  const index = row - 12
  return {
    left: 92 + (index % 3) * 632,
    top: 1696 + Math.floor(index / 3) * 312,
    width: 600,
    height: 280,
  }
}

export function signUvRect(row: number) {
  const rect = signRect(row)
  return {
    u0: rect.left / SIGN_ATLAS_WIDTH,
    u1: (rect.left + rect.width) / SIGN_ATLAS_WIDTH,
    v0: rect.top / SIGN_ATLAS_HEIGHT,
    v1: (rect.top + rect.height) / SIGN_ATLAS_HEIGHT,
  }
}
