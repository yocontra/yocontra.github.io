import type { Node } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'
import type { Building } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import type { CollisionMesh } from './frontier-collision.ts'
import type { FrontierGeometry } from './frontier-geometry.ts'
import { SHAKE_TILE } from './frontier-roof-material.ts'
import { weatheredShakes } from './frontier-weathering.ts'

export function pitchedRoof(
  g: FrontierGeometry,
  ground: Node,
  mesh: CollisionMesh,
  building: Building,
): void {
  const roof = building.roof
  if (!roof) {
    throw new Error(`Missing render pitch for ${building.id}`)
  }
  const alongX = roof.axis === 'x'
  // roofMesh writes the two triangles of each planar strip before the underside and edge faces.
  const topTriangles = (roof.bays * 2 + 2) * 2
  for (let offset = 0; offset < topTriangles * 3; offset += 6) {
    const first = (offset / 6) * 2
    const positions = mesh.positions.slice(first * 3, (first + 4) * 3)
    const low = positions[1] ?? 0
    const high = positions[7] ?? 0
    const downslope = low <= high ? -1 : 1
    const across = alongX ? 2 : 0
    const run = (positions[6 + across] ?? 0) - (positions[across] ?? 0)
    const slope = Math.hypot(run, high - low) / run
    const uvs: number[] = []
    const colors: number[] = []
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      const u = (positions[vertex + (alongX ? 0 : 2)] ?? 0) / SHAKE_TILE.along
      const v = (downslope * (positions[vertex + across] ?? 0) * slope) / SHAKE_TILE.slope
      uvs.push(u, v)
      const [x = 0, y = 0, z = 0] = positions.slice(vertex, vertex + 3)
      colors.push(...weatheredShakes(building, x, y, z), 1)
    }
    const indices = mesh.indices.slice(offset, offset + 6).map((index) => index - first)
    g.surface(ground, 'cedar-shakes', { ...mesh, positions, indices, uvs, colors })
  }
  const indices = roofIndicesWithArea(mesh, topTriangles * 3)
  g.surface(ground, 'wood', { ...mesh, indices }, [0.37, 0.32, 0.27])
}

// At the bottom of each gable the upper and lower corners coincide. A zero-area
// half-quad gives the valid neighboring triangle a zero normal in the native bake.
function roofIndicesWithArea(mesh: CollisionMesh, firstIndex: number): number[] {
  const positions = mesh.positions
  const origin = new Vec3()
  const edgeA = new Vec3()
  const edgeB = new Vec3()
  const normal = new Vec3()
  const indices: number[] = []
  for (let offset = firstIndex; offset < mesh.indices.length; offset += 3) {
    const triangle = mesh.indices.slice(offset, offset + 3)
    const [a, b, c] = triangle.map((index) => index * 3)
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error(`Incomplete roof triangle in ${mesh.id}`)
    }
    origin.set(positions[a] ?? 0, positions[a + 1] ?? 0, positions[a + 2] ?? 0)
    edgeA.set(positions[b] ?? 0, positions[b + 1] ?? 0, positions[b + 2] ?? 0).sub(origin)
    edgeB.set(positions[c] ?? 0, positions[c + 1] ?? 0, positions[c + 2] ?? 0).sub(origin)
    if (normal.cross(edgeA, edgeB).lengthSq() > 1e-12) {
      indices.push(...triangle)
    }
  }
  return indices
}
