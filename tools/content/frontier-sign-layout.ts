/** Shared board dimensions and atlas rectangles for offline Frontier authoring. */
import type { Building, Side } from '../../src/experiments/out-west/ffa/sim/layout.ts'

export const FACADE_SIGN_HEIGHT = 0.85
export const BANK_SIGN_SIZE = { width: 1.6, height: 0.42 } as const

export function facadeSignWidth(building: Building, side: Side, label: string) {
  const span = side === 'n' || side === 's' ? building.w : building.d
  return Math.min(span - 1, Math.max(5, label.length) * 0.43)
}

// All origins, including the edge padding, align to compression blocks.
export const SIGN_ATLAS_WIDTH = 4096
export const SIGN_ATLAS_HEIGHT = 3072
export const SIGN_GUTTER = 16

export function signRect(row: number) {
  if (!Number.isInteger(row) || row < 0 || row >= 28) {
    throw new Error('Expected sign row 0..27')
  }
  if (row < 12) {
    return {
      left: 16 + (row % 2) * 2048,
      top: 16 + Math.floor(row / 2) * 336,
      width: 2016,
      height: 304,
    }
  }
  if (row < 24) {
    const index = row - 12
    return {
      left: 16 + (index % 6) * 680,
      top: 2032 + Math.floor(index / 6) * 336,
      width: 648,
      height: 304,
    }
  }
  return { left: 16 + (row - 24) * 1024, top: 2704, width: 992, height: 264 }
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
