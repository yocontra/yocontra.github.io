import type { BarrelTriangle, V3 } from './barrel-topology.ts'

/** The intact cask and each fragment share one aged-oak and oxidized-iron finish. */
export function weatherBarrel(
  components: BarrelTriangle[][],
  [floor, top]: readonly [number, number],
): void {
  for (const [section, triangles] of components.entries()) {
    for (const triangle of triangles) {
      for (const vertex of triangle) {
        const [x, y, z] = vertex.p
        const angle = Math.atan2(z, x)
        const height = (y - floor) / (top - floor)
        const grain = Math.cos(angle * 19 + 0.3 * Math.sin(height * 11)) * 0.05
        const swept = Math.max(0, Math.min(1, height * 3.4))
        const rust = 0.5 + 0.5 * Math.sin(angle * 11 + height * 18)
        const tint =
          section === 0
            ? [
                0.67 + swept * 0.16 + grain,
                0.57 + swept * 0.15 + grain,
                0.48 + swept * 0.12 + grain,
              ]
            : [0.66 + rust * 0.11, 0.62 + rust * 0.09, 0.56 + rust * 0.07]
        vertex.color = vertex.color.map((value, channel) => value * (tint[channel] ?? 1)) as V3
      }
    }
  }
}
