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
    layShakeStrip(g, ground, building, { positions, alongX })
  }
  const indices = roofIndicesWithArea(mesh, topTriangles * 3)
  g.surface(ground, 'wood', { ...mesh, indices }, [0.37, 0.32, 0.27])
}

function layShakeStrip(
  g: FrontierGeometry,
  ground: Node,
  building: Building,
  { positions, alongX }: { positions: readonly number[]; alongX: boolean },
): void {
  const low = positions[1] ?? 0
  const high = positions[7] ?? 0
  const downslope = low <= high ? -1 : 1
  const across = alongX ? 2 : 0
  const run = (positions[6 + across] ?? 0) - (positions[across] ?? 0)
  const slope = Math.hypot(run, high - low) / run
  const alongAxis = alongX ? 0 : 2
  const begin = (positions[across] ?? 0) * downslope * slope
  const end = (positions[6 + across] ?? 0) * downslope * slope
  const alongStart = positions[alongAxis] ?? 0
  const alongEnd = positions[3 + alongAxis] ?? 0
  if (Math.abs(end - begin) < 1e-7) {
    return
  }
  const upslope = Math.min(begin, end)
  const downhill = Math.max(begin, end)
  const pitch = SHAKE_TILE.slope / SHAKE_TILE.courses
  const courses = [upslope]
  for (
    let edge = Math.ceil((upslope + 0.035) / pitch) * pitch;
    edge < downhill - 0.035;
    edge += pitch
  ) {
    courses.push(edge)
  }
  courses.push(downhill)
  const panels = Math.ceil((alongEnd - alongStart) / 2.2)
  const edge = (row: number, index: number) =>
    index === 0 || index === panels || row < 0 || row === courses.length - 2
      ? 0
      : Math.sin((index + 1) * 5.71 + row * 7.13 + low) * 0.014
  const point = (along: number, fall: number, thickness: number) => {
    const stride = fall / (downslope * slope)
    const y = low + ((high - low) * (fall - begin)) / (end - begin) + thickness
    return alongX ? [along, y, stride] : [stride, y, along]
  }
  const flip = alongX === (downslope === 1)
  const lay = (face: number[][], lowerLip: readonly number[][] = []) => {
    const vertices = flip ? face.toReversed() : face
    // The lip has vertical UV span even though it shares the next course's XZ edge.
    g.quad(ground, 'cedar-shakes', vertices, {
      uvs: vertices.map((p) => [
        (p[alongAxis] ?? 0) / SHAKE_TILE.along,
        ((p[across] ?? 0) * downslope * slope + (lowerLip.includes(p) ? 0.012 : 0)) /
          SHAKE_TILE.slope,
      ]),
      tints: vertices.map(([x = 0, y = 0, z = 0]) => weatheredShakes(building, x, y, z)),
    })
  }
  for (let row = 0; row < courses.length - 1; row++) {
    const head = courses[row] ?? upslope
    const butt = courses[row + 1] ?? downhill
    for (let panel = 0; panel < panels; panel++) {
      const a = alongStart + ((alongEnd - alongStart) * panel) / panels
      const b = alongStart + ((alongEnd - alongStart) * (panel + 1)) / panels
      const exposure = row === courses.length - 2 ? 0.012 : 0.018
      const heelA = point(a, butt + edge(row, panel), exposure)
      const heelB = point(b, butt + edge(row, panel + 1), exposure)
      const top = [
        point(a, head + edge(row - 1, panel), 0),
        point(b, head + edge(row - 1, panel + 1), 0),
        heelB,
        heelA,
      ]
      const lap = [
        heelA,
        heelB,
        point(b, butt + edge(row, panel + 1), 0),
        point(a, butt + edge(row, panel), 0),
      ]
      lay(top)
      lay(lap, lap.slice(2))
    }
  }
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
