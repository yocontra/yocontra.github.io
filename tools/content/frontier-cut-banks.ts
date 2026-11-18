/** Surface projection and exposed sandstone tints for the authored frontier outskirts. */
import { calculateNormals } from 'playcanvas'
import { frontierGround } from './frontier-ground.ts'

const SOIL = [0.92, 0.85, 0.7] as const
// Mesh order in frontier-ground.json: north, west, east, south.
const OUTWARD_AXES = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
] as const
const clamp = (value: number) => Math.max(0, Math.min(1, value))

export function frontierCutBanks(size: number) {
  return frontierGround(size).map((bank, index) => {
    const axis = OUTWARD_AXES[index]
    if (!axis) {
      throw new Error(`Missing terrain projection for ${bank.id}`)
    }
    const [acrossX, acrossZ] = axis
    const { positions, indices } = bank
    const normals = calculateNormals(positions, indices)
    const uvs: number[] = []
    const colors: number[] = []
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] ?? 0
      const y = positions[i + 1] ?? 0
      const z = positions[i + 2] ?? 0
      // Project part of the rise onto the apron coordinates. The tile meets flat dirt at y=0,
      // and keeps physical coverage on the steep, town-facing faces.
      const rise = Math.max(0, y) * 0.8
      uvs.push((x + acrossX * rise) / 1.8, (z + acrossZ * rise) / 1.8)
      const slope = 1 - Math.abs(normals[i + 1] ?? 1)
      const exposed = clamp((slope - 0.11) / 0.63) * clamp(y / 1.6)
      // Broader pale shelves alternate with redder bands. Undulation breaks straight stripes.
      const bed = y + 0.21 * Math.sin(x * 0.14) + 0.29 * Math.cos(z * 0.11)
      const shelf = (0.5 + 0.5 * Math.cos(bed * 2.3)) ** 2
      const oxide = 0.5 + 0.5 * Math.sin(bed * 4.1 + x * 0.07 + z * 0.09)
      const stone = [
        0.83 + 0.16 * shelf,
        0.66 + 0.18 * shelf - 0.045 * oxide,
        0.49 + 0.18 * shelf - 0.035 * oxide,
      ] as const
      colors.push(
        ...SOIL.map((base, channel) => base + exposed * ((stone[channel] ?? base) - base)),
        1,
      )
    }
    return { ...bank, uvs, colors }
  })
}
