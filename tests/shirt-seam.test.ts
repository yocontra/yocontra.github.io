import { beforeAll, expect, it } from 'bun:test'
import { file } from 'bun'
import { type BufferGeometry, type SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Actor, type Clip } from '../src/experiments/out-west/scene/actor.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'
import { propObject } from '../src/experiments/out-west/scene/props.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const models = new Map<string, GLTF>()
let animations: GLTF['animations'] = []
beforeAll(async () => {
  const load = async (name: string) =>
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(), '')
  const [player, moves] = await Promise.all([load('player'), load('moves')])
  animations = [...player.animations, ...moves.animations]
  await Promise.all(
    bases.map(async (base) => {
      const source = await load(base)
      markCharacterSlots(source)
      models.set(base, source)
    }),
  )
})

const key = (geometry: BufferGeometry, vertex: number): string => {
  const position = geometry.getAttribute('position')
  return `${position.getX(vertex)},${position.getY(vertex)},${position.getZ(vertex)}`
}
function sharedSeam(mesh: SkinnedMesh): [number, number][] {
  const geometry = mesh.geometry
  const ranges = geometry.userData.sleeveRanges as { start: number; count: number }[]
  const index = geometry.index
  if (!index) {
    throw new Error('Actual shirt has no triangles')
  }
  const sleeves = new Set(
    ranges.flatMap((range) =>
      Array.from({ length: range.count }, (_, vertex) => range.start + vertex),
    ),
  )
  const torso = new Map<string, number>()
  for (const vertex of new Set(index.array)) {
    if (!sleeves.has(vertex)) {
      torso.set(key(geometry, vertex), vertex)
    }
  }
  return [...sleeves].flatMap((vertex) => {
    const other = torso.get(key(geometry, vertex))
    return other === undefined ? [] : [[vertex, other] as [number, number]]
  })
}

/** A real sewn edge has two incident triangles after welding the material split. */
function seamEdges(mesh: SkinnedMesh, pairs: [number, number][]) {
  const geometry = mesh.geometry
  const index = geometry.index
  if (!index) {
    throw new Error('Actual seam has no triangles')
  }
  const vertices = new Set(pairs.flat())
  const edges = new Map<string, { count: number; orientation: number }>()
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    for (let side = 0; side < 3; side++) {
      const a = index.getX(triangle + side)
      const b = index.getX(triangle + ((side + 1) % 3))
      if (vertices.has(a) && vertices.has(b)) {
        const first = key(geometry, a)
        const second = key(geometry, b)
        const edge = [first, second].sort((x, y) => x.localeCompare(y)).join('/')
        const record = edges.get(edge) ?? { count: 0, orientation: 0 }
        record.count++
        record.orientation += first.localeCompare(second) < 0 ? 1 : -1
        edges.set(edge, record)
      }
    }
  }
  return [...edges.values()]
}

function distalBindings(mesh: SkinnedMesh): { count: number; core: number } {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const ranges = geometry.userData.sleeveRanges as { start: number; count: number }[]
  const core = new Set(['Hips', 'Abdomen', 'Torso', 'Chest', 'Neck', 'ShoulderL', 'ShoulderR'])
  const point = new Vector3()
  let count = 0
  let maximum = 0
  for (const side of ['L', 'R']) {
    const start = mesh.skeleton.bones
      .find((bone) => boneKey(bone.name) === `UpperArm${side}`)
      ?.getWorldPosition(new Vector3())
    const elbow = mesh.skeleton.bones
      .find((bone) => boneKey(bone.name) === `LowerArm${side}`)
      ?.getWorldPosition(new Vector3())
    if (!(start && elbow)) {
      throw new Error('Actual arm frame is missing')
    }
    const axis = elbow.sub(start)
    for (const range of ranges) {
      for (let vertex = range.start; vertex < range.start + range.count; vertex++) {
        point.fromBufferAttribute(position, vertex)
        if (
          (point.x >= 0 ? 'L' : 'R') !== side ||
          point.sub(start).dot(axis) / axis.lengthSq() < 0.6
        ) {
          continue
        }
        maximum = Math.max(maximum, coreWeight(mesh, vertex, core))
        count++
      }
    }
  }
  return { count, core: maximum }
}

function coreWeight(mesh: SkinnedMesh, vertex: number, core: ReadonlySet<string>): number {
  const indices = mesh.geometry.getAttribute('skinIndex')
  const weights = mesh.geometry.getAttribute('skinWeight')
  let total = 0
  for (let slot = 0; slot < 4; slot++) {
    const bone = mesh.skeleton.bones[indices.getComponent(vertex, slot)]
    if (bone && core.has(boneKey(bone.name))) {
      total += weights.getComponent(vertex, slot)
    }
  }
  return total
}

it.each(bases)(
  'sews the actual %s armhole closed with equal animated bindings and normals',
  (base) => {
    const model = models.get(base)
    if (!model) {
      throw new Error('Missing actual body')
    }
    const actor = new Actor(model, { base, clips: animations, seed: `seam/${base}` })
    const mesh = actor.meshes[0]
    if (!mesh) {
      throw new Error('Missing actual dressed skin')
    }
    const pairs = sharedSeam(mesh)
    expect(pairs.length).toBeGreaterThanOrEqual(24)
    const distal = distalBindings(mesh)
    expect(distal.count).toBeGreaterThan(20)
    expect(distal.core).toBeLessThan(1e-6)
    const indices = mesh.geometry.getAttribute('skinIndex')
    const weights = mesh.geometry.getAttribute('skinWeight')
    const binding = new Set<string>()
    for (const [, torso] of pairs) {
      for (let slot = 0; slot < 4; slot++) {
        const bone = mesh.skeleton.bones[indices.getComponent(torso, slot)]
        if (bone && weights.getComponent(torso, slot) > 0) {
          binding.add(boneKey(bone.name))
        }
      }
    }
    const core = new Set(['Hips', 'Abdomen', 'Torso', 'Chest', 'Neck', 'ShoulderL', 'ShoulderR'])
    expect([...binding].every((bone) => core.has(bone))).toBe(true)
    const edges = seamEdges(mesh, pairs)
    expect(edges.length).toBeGreaterThanOrEqual(24)
    expect(new Set(edges.map((edge) => edge.count))).toEqual(new Set([2]))
    expect(new Set(edges.map((edge) => edge.orientation))).toEqual(new Set([0]))
    const normal = mesh.geometry.getAttribute('normal')
    const n = new Vector3()
    const m = new Vector3()
    let normalGap = 0
    for (const [a, b] of pairs) {
      normalGap = Math.max(
        normalGap,
        n.fromBufferAttribute(normal, a).distanceTo(m.fromBufferAttribute(normal, b)),
      )
    }
    expect(normalGap).toBeLessThan(1e-6)
    const p = new Vector3()
    const q = new Vector3()
    let animatedGap = 0
    for (const clip of [
      'Idle',
      'Walk',
      'Run',
      'Idle_Gun_Pointing',
      'Reload',
      'Aim_Up',
      'Aim_Down',
      'Death',
    ] as Clip[]) {
      if (!actor.play(clip, 0)) {
        throw new Error(`Missing actual ${clip} animation`)
      }
      for (const time of [0, 0.17, 0.4, 0.63]) {
        actor.update(time)
        actor.root.updateMatrixWorld(true)
        for (const [a, b] of pairs) {
          mesh.getVertexPosition(a, p).applyMatrix4(mesh.matrixWorld)
          mesh.getVertexPosition(b, q).applyMatrix4(mesh.matrixWorld)
          animatedGap = Math.max(animatedGap, p.distanceTo(q))
        }
      }
    }
    expect(animatedGap).toBeLessThan(1e-6)
    actor.dispose()
  },
)

it('keeps the inward-bent woman elbow on the actual arm when it raises into ADS', () => {
  const source = models.get('woman')
  if (!source) {
    throw new Error('Missing actual woman model')
  }
  const actor = new Actor(source, {
    base: 'woman',
    clips: animations,
    gun: propObject(revolverDef(0.32)),
  })
  const mesh = actor.meshes[0]
  if (!mesh) {
    throw new Error('Missing actual sleeve')
  }
  const position = mesh.geometry.getAttribute('position')
  const ranges = mesh.geometry.userData.sleeveRanges as { start: number; count: number }[]
  const failed = new Vector3(-0.110_928_714_3, 1.245_592_117_3, -0.219_502_657_7)
  const point = new Vector3()
  let vertex = -1
  let distance = Number.POSITIVE_INFINITY
  for (const range of ranges) {
    for (let index = range.start; index < range.start + range.count; index++) {
      const candidate = point.fromBufferAttribute(position, index).distanceToSquared(failed)
      if (candidate < distance) {
        distance = candidate
        vertex = index
      }
    }
  }
  expect(Math.sqrt(distance)).toBeLessThan(0.025)
  const indices = mesh.geometry.getAttribute('skinIndex')
  const weights = mesh.geometry.getAttribute('skinWeight')
  const arm = mesh.skeleton.bones.findIndex((candidate) => boneKey(candidate.name) === 'UpperArmR')
  const bone = mesh.skeleton.bones[arm]
  const inverse = mesh.skeleton.boneInverses[arm]
  if (!(bone && inverse)) {
    throw new Error('Missing actual arm frame')
  }
  const influences = [0, 1, 2, 3].filter((slot) => weights.getComponent(vertex, slot) > 0)
  expect(influences.map((slot) => indices.getComponent(vertex, slot))).toEqual([arm])
  actor.play('Idle_Gun_Pointing', 0)
  actor.update(0.2)
  actor.root.updateMatrixWorld(true)
  const expected = point
    .fromBufferAttribute(position, vertex)
    .clone()
    .applyMatrix4(mesh.bindMatrix)
    .applyMatrix4(inverse)
    .applyMatrix4(bone.matrixWorld)
    .applyMatrix4(mesh.bindMatrixInverse)
    .applyMatrix4(mesh.matrixWorld)
  mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld)
  expect(point.distanceTo(expected)).toBeLessThan(1e-6)
  expect(point.z).toBeGreaterThan(failed.z + 0.05)
  actor.dispose()
})
