/** Town dirt as authored vertex tint: wagon ruts, trampled lanes and broad soil patches. */
import type { TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import type { CollisionMesh } from './frontier-collision.ts'

export type TintedMesh = CollisionMesh & { uvs: number[]; colors: number[] }
type Street = TownLayout['streets'][number]
interface Track {
  z: number
  x0: number
  x1: number
}

const SOIL = [0.92, 0.85, 0.7] as const
/** Wagon track gauge and the dense rows that resolve each rut's cross-section. */
const GAUGE = 0.8
const RUT_ROWS = [-0.36, -0.22, -0.1, 0, 0.1, 0.22, 0.36]
const TEXEL = 1.8

const fract = (value: number) => value - Math.floor(value)
const hash = (x: number, z: number) => fract(Math.sin(x * 127.1 + z * 311.7) * 43_758.5453)
const smooth = (t: number) => t * t * (3 - 2 * t)

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const u = smooth(x - ix)
  const v = smooth(z - iz)
  const top = hash(ix, iz) * (1 - u) + hash(ix + 1, iz) * u
  const bottom = hash(ix, iz + 1) * (1 - u) + hash(ix + 1, iz + 1) * u
  return top * (1 - v) + bottom * v
}

/** Wheel-track centrelines: two lanes on broad streets, one on service lanes. */
export function wagonTracks(streets: readonly Street[]): Track[] {
  return streets.flatMap((street) => {
    const centre = street.z + street.d / 2
    const lanes = street.d >= 10 ? [-2.4, 2.4] : [0]
    return lanes.flatMap((lane) =>
      [-GAUGE, GAUGE].map((side) => ({
        z: centre + lane + side,
        x0: street.x,
        x1: street.x + street.w,
      })),
    )
  })
}

interface Town {
  size: number
  streets: readonly Street[]
  tracks: readonly Track[]
}

function soilTint(x: number, z: number, { size, streets, tracks }: Town) {
  // Patches fade out toward the slab edge so the town meets the plain apron without a seam.
  const fade = Math.min(1, Math.min(x, z, size - x, size - z) / 4)
  let shade = 1 + fade * 0.08 * (valueNoise(x / 6.5, z / 6.5) * 2 - 1)
  shade += fade * 0.035 * (valueNoise(x / 1.6 + 31, z / 1.6 - 17) * 2 - 1)
  for (const street of streets) {
    const edge = Math.min(z - street.z, street.z + street.d - z)
    if (x >= street.x && x <= street.x + street.w && edge > 0) {
      shade *= 1 - 0.05 * Math.min(1, edge / 1.5)
    }
  }
  let rut = 0
  for (const track of tracks) {
    if (x >= track.x0 && x <= track.x1) {
      rut = Math.max(rut, Math.exp(-(((z - track.z) / 0.16) ** 2)))
    }
  }
  // Ruts are compacted, darker and slightly redder where wheels turned the crust.
  return [
    SOIL[0] * shade * (1 - 0.24 * rut),
    SOIL[1] * shade * (1 - 0.3 * rut),
    SOIL[2] * shade * (1 - 0.34 * rut),
  ]
}

/** Visual-only replacement for the flat town top face; physics keeps its own flat slab. */
export function townGround(layout: Pick<TownLayout, 'size' | 'streets'>): TintedMesh {
  const { size, streets } = layout
  const tracks = wagonTracks(streets)
  const town = { size, streets, tracks }
  const rows = new Set<number>()
  for (let z = 0; z <= size; z++) {
    rows.add(z)
  }
  for (const track of tracks) {
    for (const offset of RUT_ROWS) {
      const z = Math.round((track.z + offset) * 1000) / 1000
      if (z > 0 && z < size) {
        rows.add(z)
      }
    }
  }
  const zs = [...rows].sort((a, b) => a - b)
  const xs = Array.from({ length: size + 1 }, (_, i) => i)
  const positions: number[] = []
  const uvs: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (const z of zs) {
    for (const x of xs) {
      positions.push(x, 0, z)
      uvs.push(x / TEXEL, z / TEXEL)
      colors.push(...soilTint(x, z, town), 1)
    }
  }
  const columns = xs.length
  for (let row = 0; row + 1 < zs.length; row++) {
    for (let column = 0; column + 1 < columns; column++) {
      const a = row * columns + column
      const b = a + columns
      indices.push(a, b, b + 1, a, b + 1, a + 1)
    }
  }
  return { id: 'town-ground', positions, indices, uvs, colors }
}
