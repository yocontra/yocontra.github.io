/** Proportional placement of library props inside gameplay cover volumes. */
export interface PrefabFit {
  /** Repeat the prop near its authored size instead of enlarging one copy into the volume. */
  tile?: boolean
  /** Largest ratio between the per-axis scales of one copy. */
  anisotropy?: number
  /** Deterministic yaw variation per copy, in radians. */
  jitter?: number
  /** Omit copies enclosed on every side but the floor; they can never be seen. */
  hollow?: boolean
  /** Fill fraction traded for each extra copy. */
  copyCost?: number
}

export function hash01(x: number, y: number, z: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43_758.5453
  return value - Math.floor(value)
}

/** Choose copy counts and per-copy scale; never exceeds the volume on any axis. */
export function fitPrefab(natural: readonly number[], size: readonly number[], fit: PrefabFit) {
  const limit = fit.anisotropy ?? 1.1
  let best = { counts: [1, 1, 1], scale: [1, 1, 1], score: Number.NEGATIVE_INFINITY }
  const targets = fit.tile ? Array.from({ length: 46 }, (_, i) => 0.75 + i * 0.02) : [1]
  for (const target of targets) {
    const counts = size.map((value, axis) =>
      fit.tile ? Math.max(1, Math.round(value / ((natural[axis] ?? 1) * target))) : 1,
    )
    const required = size.map((value, axis) => value / ((counts[axis] ?? 1) * (natural[axis] ?? 1)))
    const smallest = Math.min(...required)
    const scale = required.map((value) => Math.min(value, smallest * limit))
    const fill = scale.reduce(
      (product, value, axis) =>
        product * ((value * (counts[axis] ?? 1) * (natural[axis] ?? 1)) / (size[axis] ?? 1)),
      1,
    )
    const copies = counts.reduce((product, value) => product * value, 1)
    const oversize = fit.tile && smallest > 1.4 ? 10 : 0
    const score =
      fill - (fit.copyCost ?? 0.02) * (copies - 1) - 0.05 * Math.abs(Math.log(smallest)) - oversize
    if (score > best.score) {
      best = { counts, scale, score }
    }
  }
  return best
}

/** Bottom-centre of each copy's cell; enclosed copies are skipped for hollow fills. */
export function* fitCells(
  area: { x: number; z: number; w: number; d: number; y0?: number; top: number },
  counts: readonly number[],
  hollow = false,
): Generator<[number, number, number]> {
  const [nx = 1, ny = 1, nz = 1] = counts
  const bottom = area.y0 ?? 0
  const cell = [area.w / nx, (area.top - bottom) / ny, area.d / nz] as const
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const enclosed = ix > 0 && iz > 0 && ix < nx - 1 && iz < nz - 1 && iy < ny - 1
        if (!(hollow && enclosed)) {
          yield [
            area.x + cell[0] * (ix + 0.5),
            bottom + cell[1] * iy,
            area.z + cell[2] * (iz + 0.5),
          ]
        }
      }
    }
  }
}
