/** Pixel-centre coverage of authored UV triangles. This module does not alter images. */
import { createHash } from 'node:crypto'

export type UVTriangle = number[][]
export function strictUVPixels(
  triangles: UVTriangle[],
  width: number,
  height: number,
): Set<number> {
  const pixels = new Set<number>()
  for (const triangle of triangles) {
    if (
      triangle.length !== 3 ||
      triangle.some((point) => point.length !== 2 || point.some((value) => !Number.isFinite(value)))
    ) {
      throw new Error('Invalid normal-domain triangle')
    }
    const [a, b, c] = triangle as [[number, number], [number, number], [number, number]]
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if (Math.abs(d) < 1e-15) {
      continue
    }
    const minX = Math.max(0, Math.floor(Math.min(...triangle.map((p) => Number(p[0]))) * width))
    const maxX = Math.min(
      width - 1,
      Math.floor(Math.max(...triangle.map((p) => Number(p[0]))) * width),
    )
    const minY = Math.max(0, Math.floor(Math.min(...triangle.map((p) => Number(p[1]))) * height))
    const maxY = Math.min(
      height - 1,
      Math.floor(Math.max(...triangle.map((p) => Number(p[1]))) * height),
    )
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = (x + 0.5) / width
        const py = (y + 0.5) / height
        const u = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d
        const v = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d
        if (Math.min(u, v, 1 - u - v) >= -1e-9) {
          pixels.add(y * width + x)
        }
      }
    }
  }
  return pixels
}
export function normalPixelHash(pixels: Set<number>): string {
  const ordered = [...pixels].sort((a, b) => a - b)
  const bytes = Buffer.alloc(ordered.length * 4)
  ordered.forEach((pixel, i) => {
    bytes.writeUInt32LE(pixel, i * 4)
  })
  return createHash('sha256').update(bytes).digest('hex')
}
export function anteriorNormalPoint(point: readonly number[]): boolean {
  const [x, y, z] = point
  return (
    x !== undefined &&
    y !== undefined &&
    z !== undefined &&
    Math.abs(x) < 0.07 &&
    y > -0.1 &&
    y < 0.025 &&
    z > 0.015
  )
}
