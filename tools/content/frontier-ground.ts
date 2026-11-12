/** Preserved authored outskirts: one continuous frame shared by terrain and all vegetation. */
import ground from '../art/environments/frontier-ground.json' with { type: 'json' }
import type { CollisionMesh } from './frontier-collision.ts'

export function frontierFlatGround(size: number) {
  return { x: -48, z: -48, w: size + 96, d: size + 96, y0: -0.06, top: 0 }
}

export function frontierGroundTransform(size: number) {
  return {
    scale: (size + ground.apron * 2) / ground.originalSize,
    translation: [-ground.apron, -0.005, -ground.apron] as [number, number, number],
  }
}

export function frontierGround(size: number): CollisionMesh[] {
  const { scale, translation } = frontierGroundTransform(size)
  return ground.meshes.map((mesh, index) => ({
    id: `outskirts:${index}`,
    positions: mesh.positions.map(
      (value, component) => value * scale + (translation[component % 3] ?? 0),
    ),
    indices: mesh.indices,
  }))
}

type Triangle = readonly [number, number, number, number, number, number, number, number, number]

function barycentricHeight(t: Triangle, x: number, z: number): number | undefined {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = t
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
  if (Math.abs(d) < 1e-9) {
    return
  }
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
  const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
  const w = 1 - u - v
  return Math.min(u, v, w) < -1e-6 ? undefined : u * ay + v * by + w * cy
}

/** Highest rendered ground surface (outskirts or flat town slab) under a world point. */
export function frontierTerrainHeight(size: number): (x: number, z: number) => number {
  const cell = 2
  const grid = new Map<string, Triangle[]>()
  for (const { positions: p, indices } of frontierGround(size)) {
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => (indices[i + k] ?? 0) * 3)
      const at = (v = 0, axis = 0) => p[v + axis] ?? 0
      const t: Triangle = [
        at(a, 0),
        at(a, 1),
        at(a, 2),
        at(b, 0),
        at(b, 1),
        at(b, 2),
        at(c, 0),
        at(c, 1),
        at(c, 2),
      ]
      const xs = [t[0], t[3], t[6]]
      const zs = [t[2], t[5], t[8]]
      for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.max(...xs) / cell; gx++) {
        for (let gz = Math.floor(Math.min(...zs) / cell); gz <= Math.max(...zs) / cell; gz++) {
          const key = `${gx},${gz}`
          const list = grid.get(key) ?? []
          list.push(t)
          grid.set(key, list)
        }
      }
    }
  }
  const slab = frontierFlatGround(size)
  return (x, z) => {
    const inside = x > slab.x && x < slab.x + slab.w && z > slab.z && z < slab.z + slab.d
    let best = inside ? slab.top : Number.NEGATIVE_INFINITY
    for (const t of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      best = Math.max(best, barycentricHeight(t, x, z) ?? best)
    }
    return best
  }
}
