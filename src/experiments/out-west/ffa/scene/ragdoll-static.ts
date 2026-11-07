/** Collision-only town geometry: merged grid solids, real openings, shared pitched surfaces. */
import { Body, Box as PhysicsBox, Plane, Trimesh, Vec3 } from 'cannon-es'
import { Box3, type BufferGeometry, Vector3 } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GeoBuilder } from '../../scene/geo.ts'
import { type Grid, type Surface, TOWN, type TownLayout } from '../sim/layout.ts'
import { surfaceTop } from '../sim/surfaces.ts'
import { dressCover } from './dressing.ts'
import { facadeSolids } from './facade-profile.ts'
import { refineStaticMesh } from './ragdoll-trimesh.ts'

const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z)

/** Greedy rectangles avoid thousands of individual grid-cell broadphase bodies. */
function mergedSolids(grid: Grid): Box3[] {
  const used = new Uint8Array(grid.tops.length)
  const boxes: Box3[] = []
  for (let row = 0; row < grid.n; row++) {
    for (let col = 0; col < grid.n; col++) {
      const index = row * grid.n + col
      const top = grid.tops[index] ?? 0
      if (used[index] || top <= 0) {
        continue
      }
      let width = 1
      while (col + width < grid.n && !used[index + width] && grid.tops[index + width] === top) {
        width++
      }
      let depth = 1
      const fullRow = (z: number) => {
        for (let x = col; x < col + width; x++) {
          if (used[z * grid.n + x] || grid.tops[z * grid.n + x] !== top) {
            return false
          }
        }
        return true
      }
      while (row + depth < grid.n && fullRow(row + depth)) {
        depth++
      }
      for (let z = row; z < row + depth; z++) {
        used.fill(1, z * grid.n + col, z * grid.n + col + width)
      }
      boxes.push(
        new Box3(
          v(col * grid.cell, 0, row * grid.cell),
          v((col + width) * grid.cell, top, (row + depth) * grid.cell),
        ),
      )
    }
  }
  return boxes
}

/** Six disjoint pieces around an opening: an arm can pass through an actual window. */
function subtract(box: Box3, hole: Box3): Box3[] {
  if (!box.intersectsBox(hole)) {
    return [box]
  }
  const cut = box.clone().intersect(hole)
  const size = cut.getSize(new Vector3())
  if (Math.min(size.x, size.y, size.z) <= 1e-6) {
    return [box]
  }
  const lo = box.min
  const hi = box.max
  const a = cut.min
  const b = cut.max
  return [
    new Box3(v(lo.x, lo.y, lo.z), v(a.x, hi.y, hi.z)),
    new Box3(v(b.x, lo.y, lo.z), v(hi.x, hi.y, hi.z)),
    new Box3(v(a.x, lo.y, lo.z), v(b.x, hi.y, a.z)),
    new Box3(v(a.x, lo.y, b.z), v(b.x, hi.y, hi.z)),
    new Box3(v(a.x, lo.y, a.z), v(b.x, a.y, b.z)),
    new Box3(v(a.x, b.y, a.z), v(b.x, hi.y, b.z)),
  ].filter((piece) => {
    const extent = piece.getSize(new Vector3())
    return extent.x > 1e-6 && extent.y > 1e-6 && extent.z > 1e-6
  })
}

function boxBody(box: Box3): Body {
  const size = box.getSize(new Vector3()).multiplyScalar(0.5)
  const center = box.getCenter(new Vector3())
  return new Body({
    mass: 0,
    shape: new PhysicsBox(new Vec3(size.x, size.y, size.z)),
    position: new Vec3(center.x, center.y, center.z),
    collisionFilterGroup: 1,
    collisionFilterMask: -2,
  })
}

function meshBody(geometries: BufferGeometry[]): Body | null {
  const vertices: number[] = []
  const indices: number[] = []
  for (const geometry of geometries) {
    const pos = geometry.getAttribute('position')
    const start = vertices.length / 3
    for (let i = 0; i < pos.count; i++) {
      vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i))
    }
    const index = geometry.getIndex()
    for (let i = 0; i < (index?.count ?? pos.count); i++) {
      indices.push(start + (index ? index.getX(i) : i))
    }
    geometry.dispose()
  }
  if (vertices.length === 0) {
    return null
  }
  if (vertices.length / 3 > 32_767) {
    throw new Error('Ragdoll static mesh exceeds16-bit collision index capacity')
  }
  const shape = new Trimesh(vertices, indices)
  refineStaticMesh(shape)
  return new Body({
    mass: 0,
    shape,
    collisionFilterGroup: 1,
    collisionFilterMask: -2,
  })
}

function surfaceCuts(surface: Surface, layout: TownLayout) {
  const xs = new Set([surface.x, surface.x + surface.w])
  const zs = new Set([surface.z, surface.z + surface.d])
  for (const building of layout.buildings) {
    const roof = building.roof
    if (
      !(
        roof &&
        Math.abs(building.height - surface.bottom) < 0.001 &&
        building.x >= surface.x &&
        building.z >= surface.z &&
        building.x + building.w <= surface.x + surface.w &&
        building.z + building.d <= surface.z + surface.d
      )
    ) {
      continue
    }
    const cuts = roof.axis === 'x' ? zs : xs
    const first = roof.axis === 'x' ? building.z : building.x
    const span = (roof.axis === 'x' ? building.d : building.w) / roof.bays
    for (let i = 0; i <= roof.bays * 2; i++) {
      cuts.add(first + (i * span) / 2)
    }
  }
  return { x: [...xs].sort((a, b) => a - b), z: [...zs].sort((a, b) => a - b) }
}

function surfaceMesh(surface: Surface, layout: TownLayout): Body | null {
  const { x, z } = surfaceCuts(surface, layout)
  const geo = new GeoBuilder()
  for (let j = 1; j < z.length; j++) {
    for (let i = 1; i < x.length; i++) {
      const x0 = x[i - 1] ?? 0
      const x1 = x[i] ?? 0
      const z0 = z[j - 1] ?? 0
      const z1 = z[j] ?? 0
      const top = (px: number, pz: number) => v(px, surfaceTop(surface, px, pz), pz)
      const a = top(x0, z0)
      const b = top(x1, z0)
      const c = top(x1, z1)
      const d = top(x0, z1)
      geo.quad(a, d, c, b, 0)
      geo.quad(
        v(x0, surface.bottom, z0),
        v(x1, surface.bottom, z0),
        v(x1, surface.bottom, z1),
        v(x0, surface.bottom, z1),
        0,
      )
      if (i === 1) {
        geo.quad(a, v(x0, surface.bottom, z0), v(x0, surface.bottom, z1), d, 0)
      }
      if (i === x.length - 1) {
        geo.quad(b, c, v(x1, surface.bottom, z1), v(x1, surface.bottom, z0), 0)
      }
      if (j === 1) {
        geo.quad(a, b, v(x1, surface.bottom, z0), v(x0, surface.bottom, z0), 0)
      }
      if (j === z.length - 1) {
        geo.quad(d, v(x0, surface.bottom, z1), v(x1, surface.bottom, z1), c, 0)
      }
    }
  }
  return meshBody([geo.build()])
}

/** Reuse the exact authored well/wagon triangles, including the shared curved canopy profile. */
function shapedBodies(layout: TownLayout, props: GLTF): Body[] {
  const bodies: Body[] = []
  for (const cover of layout.cover) {
    if (cover.kind !== 'well' && cover.kind !== 'covered_wagon') {
      continue
    }
    const builders = {
      wood: new GeoBuilder(),
      wall: new GeoBuilder(),
      stone: new GeoBuilder(),
      cloth: new GeoBuilder(),
      extra: [] as BufferGeometry[],
    }
    dressCover({
      layout: { ...layout, buildings: [], cover: [cover] },
      props,
      structure: builders,
      interior: () => builders,
      floorAt: () => 0,
      porchRoof: 3,
      kit: () => undefined,
      outskirts: () => undefined,
    })
    const meshes = [builders.wood, builders.wall, builders.stone, builders.cloth]
      .filter((g) => !g.empty)
      .map((g) => g.build())
    const body = meshBody([...meshes, ...builders.extra])
    if (body) {
      bodies.push(body)
    }
  }
  return bodies
}

export function ragdollStatic(grid: Grid, props: GLTF, layout: TownLayout = TOWN): Body[] {
  let boxes = mergedSolids(grid)
  for (const hole of grid.windowHoles) {
    const cut = new Box3(v(hole.x, hole.y0, hole.z), v(hole.x + hole.w, hole.y1, hole.z + hole.d))
    boxes = boxes.flatMap((box) => subtract(box, cut))
  }
  const floor = new Body({
    mass: 0,
    shape: new Plane(),
    collisionFilterGroup: 1,
    collisionFilterMask: -2,
  })
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
  const bodies = [floor, ...boxes.map(boxBody), ...shapedBodies(layout, props)]
  for (const surface of [
    ...grid.decks,
    ...grid.stairs,
    ...grid.overheads,
    ...grid.roofs,
    ...facadeSolids(layout),
  ]) {
    const body = surface.heightAt
      ? surfaceMesh(surface, layout)
      : boxBody(
          new Box3(
            v(surface.x, surface.bottom, surface.z),
            v(surface.x + surface.w, surface.top, surface.z + surface.d),
          ),
        )
    if (body) {
      bodies.push(body)
    }
  }
  return bodies
}

/** Cosmetic bodies stop at intact panes; only authoritative pane state opens their contact. */
export function ragdollPanes(grid: Grid): Map<number, Body> {
  return new Map(
    grid.glass.map((pane) => {
      const lo =
        pane.axis === 0
          ? v(pane.at - 0.015, pane.y0, pane.a0)
          : v(pane.a0, pane.y0, pane.at - 0.015)
      const hi =
        pane.axis === 0
          ? v(pane.at + 0.015, pane.y1, pane.a1)
          : v(pane.a1, pane.y1, pane.at + 0.015)
      return [pane.index, boxBody(new Box3(lo, hi))]
    }),
  )
}
