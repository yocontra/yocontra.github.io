import { beforeAll, expect, it } from 'bun:test'
import { file } from 'bun'
import { type SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Actor } from '../src/experiments/out-west/scene/actor.ts'
import { propObject } from '../src/experiments/out-west/scene/props.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const sources = new Map<string, GLTF>()
let clips: GLTF['animations'] = []
beforeAll(async () => {
  const load = async (name: string) =>
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(), '')
  clips = (await load('player')).animations
  await Promise.all(
    bases.map(async (base) => {
      const source = await load(base)
      markCharacterSlots(source)
      sources.set(base, source)
    }),
  )
})

/** Recover material rings independently by graph distance from the welded torso/sleeve edge. */
function capGraph(mesh: SkinnedMesh) {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const key = (vertex: number) =>
    `${position.getX(vertex)},${position.getY(vertex)},${position.getZ(vertex)}`
  const ranges = geometry.userData.sleeveRanges as { start: number; count: number }[]
  const sleeves = new Set(
    ranges.flatMap((range) => Array.from({ length: range.count }, (_, i) => range.start + i)),
  )
  const index = geometry.index
  if (!index) {
    throw new Error('Actual shirt has no triangles')
  }
  const torso = new Set([...new Set(index.array)].filter((vertex) => !sleeves.has(vertex)).map(key))
  const neighbors = new Map<number, Set<number>>()
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const vertices = [0, 1, 2].map((corner) => index.getX(triangle + corner))
    if (!vertices.every((vertex) => sleeves.has(vertex))) {
      continue
    }
    for (const vertex of vertices) {
      const around = neighbors.get(vertex) ?? new Set<number>()
      for (const other of vertices) {
        if (other !== vertex) {
          around.add(other)
        }
      }
      neighbors.set(vertex, around)
    }
  }
  const queue = [...sleeves].filter((vertex) => torso.has(key(vertex)))
  const depths = new Map(queue.map((vertex) => [vertex, 0]))
  for (const vertex of queue) {
    const depth = depths.get(vertex) ?? 0
    for (const other of neighbors.get(vertex) ?? []) {
      if (!depths.has(other)) {
        depths.set(other, depth + 1)
        queue.push(other)
      }
    }
  }
  return { neighbors, depths }
}
function points(mesh: SkinnedMesh, graph: ReturnType<typeof capGraph>): Map<number, Vector3> {
  return new Map(
    [...graph.depths]
      .filter(([, depth]) => depth <= 10)
      .map(([vertex]) => [
        vertex,
        mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld),
      ]),
  )
}
function profile(
  mesh: SkinnedMesh,
  graph: ReturnType<typeof capGraph>,
  posed: Map<number, Vector3>,
) {
  const rings = new Map<string, number[]>()
  const position = mesh.geometry.getAttribute('position')
  for (const [vertex, depth] of graph.depths) {
    if (depth > 10) {
      continue
    }
    const key = `${position.getX(vertex) >= 0 ? 'L' : 'R'}:${depth}`
    const ring = rings.get(key) ?? []
    ring.push(vertex)
    rings.set(key, ring)
  }
  let ratio = 0
  let edge = 0
  let step = 0
  const centers = new Map<string, Vector3>()
  for (const [key, ring] of rings) {
    const measured = ringProfile(ring, graph, posed)
    centers.set(key, measured.center)
    ratio = Math.max(ratio, measured.ratio)
    edge = Math.max(edge, measured.edge)
  }
  for (const side of ['L', 'R']) {
    for (let depth = 1; depth <= 10; depth++) {
      const previous = centers.get(`${side}:${depth - 1}`)
      const next = centers.get(`${side}:${depth}`)
      if (previous && next) {
        step = Math.max(step, previous.distanceTo(next))
      }
    }
  }
  return { count: rings.size, ratio, edge, step }
}
function ringProfile(
  ring: number[],
  graph: ReturnType<typeof capGraph>,
  posed: Map<number, Vector3>,
) {
  const center = new Vector3()
  const lengths: number[] = []
  for (const vertex of ring) {
    const point = posedPoint(posed, vertex)
    center.add(point)
    for (const other of graph.neighbors.get(vertex) ?? []) {
      if (graph.depths.get(vertex) === graph.depths.get(other)) {
        lengths.push(point.distanceTo(posedPoint(posed, other)))
      }
    }
  }
  return {
    center: center.divideScalar(ring.length),
    ratio: Math.max(...lengths) / Math.min(...lengths),
    edge: Math.max(...lengths),
  }
}
function posedPoint(posed: Map<number, Vector3>, vertex: number): Vector3 {
  const point = posed.get(vertex)
  if (!point) {
    throw new Error('Missing actual cap point')
  }
  return point
}
function trajectory(
  graph: ReturnType<typeof capGraph>,
  before: Map<number, Vector3>,
  after: Map<number, Vector3>,
): number {
  let maximum = 0
  for (const [vertex, point] of before) {
    const current = after.get(vertex)
    if (!current) {
      continue
    }
    for (const other of graph.neighbors.get(vertex) ?? []) {
      const oldNeighbor = before.get(other)
      const newNeighbor = after.get(other)
      if (
        oldNeighbor &&
        newNeighbor &&
        Math.abs((graph.depths.get(vertex) ?? 0) - (graph.depths.get(other) ?? 0)) === 1
      ) {
        maximum = Math.max(
          maximum,
          current.clone().sub(newNeighbor).sub(point.clone().sub(oldNeighbor)).length(),
        )
      }
    }
  }
  return maximum
}

it.each(bases)(
  'keeps %s neighboring cap contours coherent through the actual Idle→ADS trajectory',
  (base) => {
    const source = sources.get(base)
    if (!source) {
      throw new Error('Missing actual body')
    }
    const actor = new Actor(source, { base, clips, gun: propObject(revolverDef(0.32)) })
    actor.draw()
    actor.play('Idle', 0)
    actor.update(0)
    const mesh = actor.meshes[0]
    if (!mesh) {
      throw new Error('Missing actual shirt')
    }
    const graph = capGraph(mesh)
    const before = points(mesh, graph)
    const idle = profile(mesh, graph, before)
    for (const [clip, time] of [
      ['Walk', 0.2],
      ['Walk', 0.65],
      ['Run', 0.15],
      ['Idle_Gun_Pointing', 0.2],
    ] as const) {
      actor.play(clip, 0)
      actor.update(time)
    }
    actor.root.updateMatrixWorld(true)
    const after = points(mesh, graph)
    const ads = profile(mesh, graph, after)
    expect(idle.count).toBe(22)
    expect(ads.count).toBe(22)
    expect(Math.max(idle.ratio, ads.ratio)).toBeLessThan(6)
    expect(Math.max(idle.edge, ads.edge)).toBeLessThan(0.06)
    expect(Math.max(idle.step, ads.step)).toBeLessThan(0.065)
    // The rejected native quad changed its neighbor delta by19.3cm across one cap segment.
    expect(trajectory(graph, before, after)).toBeLessThan(0.09)
    actor.dispose()
  },
)
