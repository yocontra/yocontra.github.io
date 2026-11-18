/** Local rock profiles for the two landmarks visible above Frontier's perimeter. */
import type { CollisionMesh } from './frontier-collision.ts'

interface Mesa {
  center: readonly [number, number]
  radii: readonly [number, number]
  floor: number
  profile: readonly (readonly [number, number])[]
  phase: number
}

const MESAS = new Map<string, Mesa>([
  [
    'outskirts:0',
    {
      center: [0.5, -40.2],
      radii: [14.5, 11.8],
      floor: 8.8,
      profile: [
        [0, 18.7],
        [0.28, 18.4],
        [0.38, 17.7],
        [0.48, 14.3],
        [0.61, 13.8],
        [0.7, 11.4],
        [1, 8.9],
      ],
      phase: 1.3,
    },
  ],
  [
    'outskirts:1',
    {
      center: [-24.1, 59.5],
      radii: [10.1, 10.8],
      floor: 5.2,
      profile: [
        [0, 14.0],
        [0.15, 13.6],
        [0.24, 12.9],
        [0.34, 10.1],
        [0.47, 9.65],
        [0.54, 8.1],
        [0.67, 7.5],
        [1, 5.2],
      ],
      phase: -0.7,
    },
  ],
])

function smooth(t: number) {
  const value = Math.min(1, Math.max(0, t))
  return value * value * (3 - 2 * value)
}

function profileHeight(profile: Mesa['profile'], radius: number, floor: number) {
  for (let i = 1; i < profile.length; i++) {
    const lower = profile[i - 1]
    const upper = profile[i]
    if (lower && upper && radius <= upper[0]) {
      const t = smooth((radius - lower[0]) / (upper[0] - lower[0]))
      return lower[1] + (upper[1] - lower[1]) * t
    }
  }
  return floor
}

function sculptedHeight(mesa: Mesa, x: number, y: number, z: number) {
  const a = (x - mesa.center[0]) / mesa.radii[0]
  const b = (z - mesa.center[1]) / mesa.radii[1]
  const radius = Math.hypot(a, b)
  const blend = smooth((1.13 - radius) / 0.33) * smooth((y - mesa.floor) / 1.7)
  if (blend === 0) {
    return y
  }
  const angle = Math.atan2(b, a) + mesa.phase
  const erosion = 1 + 0.08 * Math.sin(angle * 3) + 0.045 * Math.cos(angle * 7)
  const beds = 0.27 * Math.sin(a * 5.7 + b * 3.5) + 0.18 * Math.cos(b * 7.2 - a * 2.1)
  const rock = Math.max(
    mesa.floor,
    profileHeight(mesa.profile, radius * erosion, mesa.floor) + beds,
  )
  return y + (rock - y) * blend
}

/** A shared edge makes the same cut on both incident faces, including at the patch boundary. */
function splitEdges(indices: readonly number[], midpoint: (a: number, b: number) => number) {
  const faces: number[] = []
  for (let i = 0; i < indices.length; i += 3) {
    const [a = 0, b = 0, c = 0] = indices.slice(i, i + 3)
    const corners = [a, b, c]
    const cuts = [midpoint(a, b), midpoint(b, c), midpoint(c, a)]
    const first = cuts.findIndex((cut) => cut >= 0)
    if (first === -1) {
      faces.push(a, b, c)
      continue
    }
    const left = corners[first] ?? a
    const right = corners[(first + 1) % 3] ?? b
    const tip = corners[(first + 2) % 3] ?? c
    const edge = cuts[first] ?? -1
    const rightCut = cuts[(first + 1) % 3] ?? -1
    const leftCut = cuts[(first + 2) % 3] ?? -1
    if (rightCut >= 0 && leftCut >= 0) {
      faces.push(
        left,
        edge,
        leftCut,
        edge,
        right,
        rightCut,
        leftCut,
        rightCut,
        tip,
        edge,
        rightCut,
        leftCut,
      )
    } else if (rightCut >= 0) {
      faces.push(left, edge, tip, edge, right, rightCut, edge, rightCut, tip)
    } else if (leftCut >= 0) {
      faces.push(left, edge, leftCut, edge, right, tip, edge, tip, leftCut)
    } else {
      faces.push(left, edge, tip, edge, right, tip)
    }
  }
  return faces
}

/** Render detail sits beyond the perimeter. The low apron and plant roots retain their old surface. */
export function sculptFrontierMesa(bank: CollisionMesh): CollisionMesh {
  const mesa = MESAS.get(bank.id)
  if (!mesa) {
    return bank
  }
  const positions = [...bank.positions]
  const midpoints = new Map<string, number>()
  const midpoint = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    const cached = midpoints.get(key)
    if (cached !== undefined) {
      return cached
    }
    const [ax = 0, ay = 0, az = 0] = positions.slice(3 * a, 3 * a + 3)
    const [bx = 0, by = 0, bz = 0] = positions.slice(3 * b, 3 * b + 3)
    const dx = bx - ax
    const dz = bz - az
    const x = (ax + bx) / 2
    const y = (ay + by) / 2
    const z = (az + bz) / 2
    const radius = Math.hypot(
      (x - mesa.center[0]) / mesa.radii[0],
      (z - mesa.center[1]) / mesa.radii[1],
    )
    const split = Math.max(ay, by) > mesa.floor && radius < 1.23 && Math.hypot(dx, dz) > 0.63
    const id = split ? positions.length / 3 : -1
    if (split) {
      positions.push(x, y, z)
    }
    midpoints.set(key, id)
    return id
  }
  const indices = splitEdges(splitEdges(bank.indices, midpoint), midpoint)
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = sculptedHeight(
      mesa,
      positions[i] ?? 0,
      positions[i + 1] ?? 0,
      positions[i + 2] ?? 0,
    )
  }
  return { ...bank, positions, indices }
}
