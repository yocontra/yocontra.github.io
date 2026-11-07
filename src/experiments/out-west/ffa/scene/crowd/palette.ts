/** Palette identity is authored metadata; vertex brightness is independent of that identity. */
export function paletteColor(
  slot: number,
  color: readonly [number, number, number],
  markers: readonly (readonly [number, number, number])[],
): [number, number, number] {
  if (slot === 0) {
    return [...color]
  }
  const marker = markers[slot - 1]
  if (!marker) {
    throw new Error(`Missing palette marker${slot}`)
  }
  const length = marker[0] ** 2 + marker[1] ** 2 + marker[2] ** 2
  const scale =
    (color[0] * marker[0] + color[1] * marker[1] + color[2] * marker[2]) / Math.max(1e-8, length)
  return [scale, scale, scale]
}
