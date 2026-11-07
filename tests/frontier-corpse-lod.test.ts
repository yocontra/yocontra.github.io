import { afterEach, beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import { Group, Mesh, SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import {
  corpseLodStats,
  prepareCorpseLod,
  setCorpseDetail,
} from '../src/experiments/out-west/ffa/scene/corpse-lod.ts'
import { corpseLodJob } from '../src/experiments/out-west/ffa/scene/corpse-lod-job.ts'
import {
  cloneCorpse,
  prepareCorpseFit,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  geometryReferences,
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { dressedActor } from '../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'

// The module object is needed for the worker-failure injection, rather than a production hook.
const lodJobs = await import('../src/experiments/out-west/scene/lod.ts')
afterEach(() => {
  const { models } = corpseLodStats()
  if (models !== 0) {
    throw new Error(`Test retained ${models} corpse LOD owners`)
  }
})

let source: GLTF
beforeAll(async () => {
  source = await new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(await file('public/experiments/out-west/3d/models/player.glb').arrayBuffer(), '')
  markCharacterSlots(source)
})

function fixture() {
  const actor = dressedActor(source, revolverDef(0.32), {
    outfit: 'outfit.striped-poncho',
    gun: 'gun.hardins-pair',
    hat: 'hat.sombrero',
  })
  new Group().add(actor.root)
  actor.play('Idle_Gun_Pointing', 0)
  actor.update(0.37)
  const skin = actor.meshes[0]
  if (!skin) {
    throw new Error('Missing actual dressed body')
  }
  ownGeometry(skin.geometry)
  prepareCorpseFit(actor)
  const rig = cloneCorpse(actor, skin.geometry, 'actual/lod')
  return {
    rig,
    full: skin.geometry,
    cleanup: () => {
      rig.dispose()
      releaseGeometry(skin.geometry)
      actor.dispose()
    },
  }
}

it('reduces actual dressed body and gun indices while preserving the full skin and private cloth data', async () => {
  const f = fixture()
  const meshes: Mesh[] = []
  f.rig.root.traverse((node) => {
    if (node instanceof Mesh) {
      meshes.push(node)
    }
  })
  const originals = meshes.map((mesh) => mesh.geometry)
  const originalIndices = originals.map((geometry) => geometry.index?.array.slice())
  const originalTriangles = originals.reduce(
    (total, geometry) =>
      total + (geometry.index?.count ?? geometry.getAttribute('position').count) / 3,
    0,
  )
  const preparation = prepareCorpseLod(f.rig)
  expect(prepareCorpseLod(f.rig)).toBe(preparation)
  await preparation
  setCorpseDetail(f.rig, 10, true)
  let triangles = 0
  for (const [index, mesh] of meshes.entries()) {
    const full = originals[index]
    if (!full) {
      throw new Error('Missing source geometry')
    }
    for (const [name, attribute] of Object.entries(full.attributes)) {
      expect(mesh.geometry.getAttribute(name)).toBe(attribute)
    }
    expect(mesh.material).toBeDefined()
    expect(mesh.geometry.index?.count).toBeLessThanOrEqual(
      full.index?.count ?? full.getAttribute('position').count,
    )
    expect(full.index?.array).toEqual(originalIndices[index])
    triangles += (mesh.geometry.index?.count ?? 0) / 3
  }
  expect(triangles).toBeLessThan(originalTriangles * 0.6)
  const skin = meshes.find((mesh): mesh is SkinnedMesh => mesh instanceof SkinnedMesh)
  if (!skin) {
    throw new Error('LOD must retain actual skinned model')
  }
  expect(skin.geometry.index?.count).toBeLessThan((f.full.index?.count ?? 0) * 0.65)
  const point = skin.getVertexPosition(37, new Vector3()).clone()
  setCorpseDetail(f.rig, 1, true)
  expect(meshes.every((mesh, index) => mesh.geometry === originals[index])).toBe(true)
  expect(skin.getVertexPosition(37, new Vector3()).distanceTo(point)).toBe(0)
  setCorpseDetail(f.rig, 20, false)
  expect(meshes.every((mesh, index) => mesh.geometry === originals[index])).toBe(true)
  f.cleanup()
})

it('retains binding, fabric, palette and cloth distinctions when welding coincident vertices', () => {
  const f = fixture()
  const job = corpseLodJob(f.full)
  expect(job.seams?.length).toBe(f.full.getAttribute('position').count)
  expect(job.weights?.length).toBe(job.stride)
  expect(job.weights?.length).toBeLessThanOrEqual(32)
  expect(new Set(job.seams).size).toBeGreaterThan(18)
  expect(job.index).toEqual(Uint32Array.from(f.full.index?.array ?? []))
  f.cleanup()
})

it('releases an arriving LOD after disposal without touching the retained source geometry', async () => {
  const f = fixture()
  const preparation = prepareCorpseLod(f.rig)
  f.rig.dispose()
  await preparation
  setCorpseDetail(f.rig, 10, true)
  expect(geometryReferences(f.full)).toBe(1)
  expect(f.rig.root.parent).toBeNull()
  f.cleanup()
})

it('keeps the intact dressed rig and its original indices when an optional worker job fails', async () => {
  const f = fixture()
  const meshes: Mesh[] = []
  f.rig.root.traverse((node) => {
    if (node instanceof Mesh) {
      meshes.push(node)
    }
  })
  const original = meshes.map((mesh) => mesh.geometry)
  const simplify = spyOn(lodJobs, 'simplifyAsync').mockRejectedValue(new Error('worker failed'))
  const warning = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    await prepareCorpseLod(f.rig)
    setCorpseDetail(f.rig, 10, true)
    expect(meshes.every((mesh, index) => mesh.geometry === original[index])).toBe(true)
    expect(geometryReferences(f.full)).toBe(2)
    f.rig.pose(f.rig.links)
    expect(f.rig.root.children.length).toBeGreaterThan(0)
  } finally {
    simplify.mockRestore()
    warning.mockRestore()
    f.cleanup()
  }
})

it('attaches actual dressed physics before a held LOD response and ignores its late result after respawn', async () => {
  const f = fixture()
  const props = await new GLTFLoader().parseAsync(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    '',
  )
  const layout = { ...TOWN, buildings: [], cover: [], catwalks: [] }
  const pool = new Ragdolls({
    root: new Group(),
    props,
    layout,
    grid: buildGrid(layout),
    source: {
      captureCorpse: () => Promise.resolve(f.rig),
      suppressCorpse: () => true,
      releaseCorpse: () => undefined,
    },
  })
  const pending: ((result: { index: Uint32Array; error: number }) => void)[] = []
  const simplify = spyOn(lodJobs, 'simplifyAsync').mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  )
  try {
    await pool.killed(1, { x: 2, z: 2 }, null, { tick: 0 })
    expect(pool.stats.corpses).toBe(1)
    expect(pending.length).toBeGreaterThan(0)
    pool.update(1 / 60)
    expect(pool.stats.steps).toBeGreaterThan(0)
    pool.released(1)
    for (const resolve of pending) {
      resolve({ index: new Uint32Array([0, 1, 2]), error: 0 })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pool.stats.corpses).toBe(0)
    expect(geometryReferences(f.full)).toBe(1)
  } finally {
    simplify.mockRestore()
    pool.dispose()
    f.cleanup()
  }
})
