import { beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import {
  type Box3,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  SkinnedMesh,
  Sphere,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import {
  type CorpsePose,
  type CorpseRig,
  cloneCorpse,
  prepareCorpseFit,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { Actor, type Clip } from '../src/experiments/out-west/scene/actor.ts'
import {
  equippedGun,
  fitCatalogSpurs,
  loadoutOpts,
} from '../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'
import { rifleObject } from '../src/experiments/out-west/scene/rifle.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const outfits = [
  'outfit.trail-duds',
  'outfit.shirt-vest',
  'outfit.wool-duster',
  'outfit.striped-poncho',
  'outfit.gamblers-frock',
  'outfit.bandolier-rig',
  'outfit.undertakers-black',
  'outfit.midnight-coat',
] as const
const clips: Clip[] = ['Idle', 'Run', 'Idle_Gun_Pointing', 'Reload', 'Death']
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
      const model = await load(base)
      markCharacterSlots(model)
      models.set(base, model)
    }),
  )
})

function fixture(base: (typeof bases)[number], outfit: string, clip: Clip): CorpseRig {
  const model = models.get(base)
  if (!model) {
    throw new Error('Missing actual model')
  }
  const actor = new Actor(model, {
    ...loadoutOpts({
      outfit,
      hat: 'hat.sombrero',
      extra: 'extra.red-bandana',
      holster: 'holster.buscadero',
    }),
    base,
    clips: animations,
    gun: equippedGun(revolverDef(0.32), 'gun.hardins-pair'),
    offGun: true,
    seed: `bounds/${base}/${outfit}/${clip}`,
  })
  fitCatalogSpurs(actor, 'spurs.silver-jinglebobs')
  const stage = new Group()
  stage.position.set(-7, 3, 4)
  stage.rotation.set(0.1, 0.8, 0.05)
  stage.add(actor.root)
  actor.root.position.set(20, 8, -64)
  actor.root.scale.setScalar(base === 'woman' ? 1 : 1.25)
  if (!actor.play(clip, 0)) {
    throw new Error(`Missing real animation ${clip}`)
  }
  actor.update(0.37)
  if (outfit === 'outfit.striped-poncho') {
    actor.holdLong(actor.addLong(rifleObject()))
    actor.update(0)
  }
  stage.updateMatrixWorld(true)
  const full = actor.meshes[0]?.geometry
  if (!full) {
    throw new Error('Missing actual skin')
  }
  ownGeometry(full)
  prepareCorpseFit(actor)
  const rig = cloneCorpse(actor, full, `bounds/${base}`)
  releaseGeometry(full)
  actor.dispose()
  return rig
}

function visibleMeshes(root: Object3D): Mesh[] {
  const result: Mesh[] = []
  root.traverseVisible((node) => {
    if (node instanceof Mesh) {
      result.push(node)
    }
  })
  return result
}

function containVertices(rig: CorpseRig, bounds: Box3): number {
  const point = new Vector3()
  const sphere = new Sphere()
  let count = 0
  for (const mesh of visibleMeshes(rig.root)) {
    if (mesh instanceof SkinnedMesh) {
      if (!mesh.boundingSphere) {
        throw new Error('Skin has no owned culling sphere')
      }
      sphere.copy(mesh.boundingSphere).applyMatrix4(mesh.matrixWorld)
    }
    const position = mesh.geometry.getAttribute('position')
    for (let vertex = 0; vertex < position.count; vertex++) {
      mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld)
      if (!bounds.containsPoint(point)) {
        throw new Error(
          `${mesh.name} vertex ${vertex} outside current world bounds: ${point.toArray()}`,
        )
      }
      if (mesh instanceof SkinnedMesh && !sphere.containsPoint(point)) {
        throw new Error(`Skin vertex ${vertex} outside Three's world culling sphere`)
      }
      count++
    }
    if (!mesh.frustumCulled) {
      throw new Error('Mesh does not use Three frustum culling')
    }
  }
  return count
}

function target(rig: CorpseRig, frame: number, x = 0): CorpsePose[] {
  const axis = new Vector3(0.3, 0.8, -0.4).normalize()
  return rig.links.map((link, index) => ({
    // Exercise physical joint-origin separation independently of the captured hierarchy.
    position: link.position.clone().add(new Vector3(x + index * 0.02, -frame * 3, frame * 4)),
    rotation: link.rotation
      .clone()
      .premultiply(new Quaternion().setFromAxisAngle(axis, frame * 0.8 + index * 0.06)),
  }))
}

it.each(bases)('contains the actual %s skin, fitted gear and maximum cloth offset', (base) => {
  let vertices = 0
  for (const [index, outfit] of outfits.entries()) {
    const clip = clips[(bases.indexOf(base) + index) % clips.length] ?? 'Idle'
    const rig = fixture(base, outfit, clip)
    const bounds = rig.bounds
    if (!bounds) {
      throw new Error('Production clone has no bounds')
    }
    const original = rig.root.matrixWorld.clone()
    const current = bounds(rig.links)
    for (let frame = 0; frame < 3; frame++) {
      const poses = target(rig, frame, frame * 40)
      const predicted = bounds(poses).clone()
      expect(bounds(poses)).toBe(current)
      expect(rig.root.matrixWorld.equals(original)).toBe(true)
      rig.pose(poses, (_x, _y, _z, correction) => {
        correction?.set(0.31, -0.27, 0.4)
        return Number.NEGATIVE_INFINITY
      })
      vertices += containVertices(rig, predicted)
    }
    rig.dispose()
  }
  expect(vertices).toBeGreaterThan(100_000)
})

it('updates Three culling away from the death origin and reenters with the exact current pose', () => {
  const rig = fixture('rugged', 'outfit.striped-poncho', 'Run')
  const expected = fixture('rugged', 'outfit.striped-poncho', 'Run')
  const camera = new PerspectiveCamera(55, 1.6, 0.1, 80)
  const center = rig.links[0]?.position.clone() ?? new Vector3()
  camera.position.copy(center).add(new Vector3(0, 1, 8))
  camera.lookAt(center)
  camera.updateMatrixWorld(true)
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  )
  const bounds = rig.bounds
  if (!bounds) {
    throw new Error('No production bounds')
  }
  expect(frustum.intersectsBox(bounds(rig.links))).toBe(true)
  const matrix = rig.root.matrixWorld.clone()
  const scan = spyOn(SkinnedMesh.prototype, 'getVertexPosition').mockImplementation(() => {
    throw new Error('Visibility must not scan skin vertices')
  })
  try {
    for (let frame = 0; frame < 10; frame++) {
      expect(frustum.intersectsBox(bounds(target(rig, 0, 100 + frame)))).toBe(false)
      expected.pose(target(expected, 0, 100 + frame))
    }
  } finally {
    scan.mockRestore()
  }
  expect(rig.root.matrixWorld.equals(matrix)).toBe(true)
  const poses = target(rig, 0)
  expect(frustum.intersectsBox(bounds(poses))).toBe(true)
  rig.pose(poses)
  expected.pose(target(expected, 0))
  const skin = visibleMeshes(rig.root).find((mesh) => mesh instanceof SkinnedMesh)
  if (!skin) {
    throw new Error('Actual skinned body is missing')
  }
  expect(frustum.intersectsObject(skin)).toBe(true)
  const other = visibleMeshes(expected.root)
  for (const [index, mesh] of visibleMeshes(rig.root).entries()) {
    const want = other[index]
    if (!want) {
      throw new Error('Actual gear hierarchy changed')
    }
    expect(
      Math.max(
        ...mesh.matrixWorld.elements.map((n, i) =>
          Math.abs(n - (want.matrixWorld.elements[i] ?? 0)),
        ),
      ),
    ).toBeLessThan(1e-9)
  }
  containVertices(rig, bounds(poses))
  rig.dispose()
  expected.dispose()
})

it('clears suspended cloth history before solving the current clear support on reentry', () => {
  const rig = fixture('rugged', 'outfit.striped-poncho', 'Run')
  const body = visibleMeshes(rig.root).find((mesh) => mesh instanceof SkinnedMesh)
  if (!(body && rig.bounds && rig.resetCloth)) {
    throw new Error('Production corpse lacks reentry support')
  }
  const original = rig.sourceGeometry?.getAttribute('position')
  const positions = Array.from(original?.array ?? [])
  rig.pose(rig.links, (_x, _y, _z, out) => {
    out?.set(0.4, -0.1, 0.3)
    return Number.NEGATIVE_INFINITY
  })
  const offset = body.geometry.getAttribute('corpseOffset')
  expect(Math.max(...offset.array)).toBeGreaterThan(0.1)
  for (let frame = 0; frame < 10; frame++) {
    rig.bounds(target(rig, 0, 100 + frame))
  }
  const before = body.matrixWorld.clone()
  rig.resetCloth()
  expect(body.matrixWorld.equals(before)).toBe(true)
  rig.pose(target(rig, 0), () => Number.NEGATIVE_INFINITY)
  expect(Math.max(...offset.array.map(Math.abs))).toBe(0)
  expect(Array.from(original?.array ?? [])).toEqual(positions)
  expect(rig.sourceGeometry?.hasAttribute('corpseOffset')).toBe(false)
  rig.dispose()
})
