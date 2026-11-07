import { beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import {
  Bone,
  BufferAttribute,
  Group,
  Matrix3,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import {
  type CorpsePose,
  type CorpseRig,
  cloneCorpse,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'
import { dressedActor } from '../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const models = new Map<string, GLTF>()
let clips: GLTF['animations'] = []
beforeAll(async () => {
  const load = async (name: string) =>
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(), '')
  const [player, moves] = await Promise.all([load('player'), load('moves')])
  clips = [...player.animations, ...moves.animations]
  await Promise.all(
    bases.map(async (base) => {
      const model = await load(base)
      markCharacterSlots(model)
      models.set(base, model)
    }),
  )
})
/** Independent recursive world-frame mapping retained as the exact transform oracle. */
function legacyPose(rig: CorpseRig, poses: readonly CorpsePose[]): void {
  const byKey = new Map<string, Bone>()
  rig.root.traverse((node) => {
    if (node instanceof Bone) {
      byKey.set(boneKey(node.name), node)
    }
  })
  const inverse = new Quaternion()
  for (const [i, link] of rig.links.entries()) {
    const bone = byKey.get(link.key)
    const target = poses[i]
    if (!(bone && target)) {
      continue
    }
    bone.parent?.updateWorldMatrix(true, false)
    bone.position.copy(target.position)
    bone.parent?.worldToLocal(bone.position)
    inverse.identity()
    bone.parent?.getWorldQuaternion(inverse)
    bone.quaternion.copy(inverse.invert().multiply(target.rotation))
    bone.updateMatrix()
    bone.updateMatrixWorld(true)
  }
  rig.root.updateMatrixWorld(true)
}
function nodes(root: Object3D): Object3D[] {
  const found: Object3D[] = []
  root.traverse((node) => found.push(node))
  return found
}
it.each(bases)(
  'keeps every actual %s skin vertex and rigid attachment identical to recursive posing',
  (base) => {
    const model = models.get(base)
    if (!model) {
      throw new Error('Missing model')
    }
    const actor = dressedActor(model, revolverDef(0.32), {
      base,
      clips,
      outfit: base === 'woman' ? 'outfit.striped-poncho' : 'outfit.gamblers-frock',
      gun: 'gun.hardins-pair',
      hat: 'hat.bronze-band',
      spurs: 'spurs.silver-jinglebobs',
      seed: 'exact-pose',
    })
    const stage = new Group()
    stage.position.set(3, 2, 1)
    stage.rotation.y = 0.4
    stage.add(actor.root)
    actor.root.position.set(20, 4, 64)
    actor.root.scale.setScalar(1.25)
    const geometry = actor.meshes[0]?.geometry
    if (!geometry) {
      throw new Error('Missing actual body')
    }
    ownGeometry(geometry)
    actor.play('Idle_Gun_Pointing', 0)
    actor.update(0.37)
    stage.updateMatrixWorld(true)
    const actual = cloneCorpse(actor, geometry, 'actual')
    const expected = cloneCorpse(actor, geometry, 'expected')
    const actualNodes = nodes(actual.root)
    const expectedNodes = nodes(expected.root)
    const axis = new Vector3(0.2, 0.7, 0.3).normalize()
    const turn = new Quaternion()
    let matrixError = 0
    let vertexError = 0
    let currentUpdates = 0
    let recursiveUpdates = 0
    const previous = new WeakMap<SkinnedMesh, Float32Array>()
    const ground = (x: number, _y: number, z: number, correction?: Vector3): number => {
      correction?.set(x > 44.5 ? 0.03 : 0, 0, z > 51 ? 0.02 : 0)
      return 7.3 + Math.sin(x) * 0.1
    }
    const p = new Vector3()
    const q = new Vector3()
    for (let frame = 0; frame < 4; frame++) {
      turn.setFromAxisAngle(axis, 0.17 * frame)
      const poses = actual.links.map((link) => ({
        position: link.position.clone().add(new Vector3(0.1 * frame, -0.2 * frame, 0.05 * frame)),
        rotation: link.rotation.clone().premultiply(turn),
      }))
      currentUpdates += countTransforms(() => actual.pose(poses))
      recursiveUpdates += countTransforms(() => legacyPose(expected, poses))
      // Contact conformance reads the independently posed skeleton; it must not change bone frames.
      actual.pose([], ground)
      referenceCloth(expected, previous, ground)
      for (const [i, node] of actualNodes.entries()) {
        const other = expectedNodes[i]
        if (!other) {
          throw new Error('Clone hierarchy changed')
        }
        for (let entry = 0; entry < 16; entry++) {
          matrixError = Math.max(
            matrixError,
            Math.abs(
              (node.matrixWorld.elements[entry] ?? 0) - (other.matrixWorld.elements[entry] ?? 0),
            ),
          )
        }
        if (node instanceof SkinnedMesh && other instanceof SkinnedMesh) {
          for (let v = 0; v < node.geometry.getAttribute('position').count; v++) {
            node.getVertexPosition(v, p).applyMatrix4(node.matrixWorld)
            other.getVertexPosition(v, q).applyMatrix4(other.matrixWorld)
            vertexError = Math.max(vertexError, p.distanceTo(q))
          }
        }
      }
    }
    const boundedUploads = actualNodes
      .filter((node): node is SkinnedMesh => node instanceof SkinnedMesh)
      .every((mesh) => {
        const offset = mesh.geometry.getAttribute('corpseOffset')
        const ranges = mesh.geometry.userData.clothRanges as unknown[] | undefined
        return (
          !offset ||
          (offset instanceof BufferAttribute && offset.updateRanges.length <= (ranges?.length ?? 0))
        )
      })
    expect(boundedUploads).toBe(true)
    expect(currentUpdates).toBeLessThan(recursiveUpdates / 3)
    expect(matrixError).toBeLessThan(1e-9)
    expect(vertexError).toBeLessThan(1e-7)
    actual.dispose()
    expected.dispose()
    releaseGeometry(geometry)
    actor.dispose()
  },
)

/** Independent CPU skinning oracle, with the original per-vertex contact/release math. */
function referenceCloth(
  rig: CorpseRig,
  previous: WeakMap<SkinnedMesh, Float32Array>,
  ground: (x: number, y: number, z: number, out?: Vector3) => number,
): void {
  rig.root.traverse((node) => {
    if (!(node instanceof SkinnedMesh)) {
      return
    }
    const offset = node.geometry.getAttribute('corpseOffset')
    if (!offset) {
      return
    }
    const ranges = node.geometry.userData.clothRanges as { start: number; count: number }[]
    const old = previous.get(node) ?? new Float32Array(offset.count * 3)
    previous.set(node, old)
    const point = new Vector3()
    const correction = new Vector3()
    const inverse = new Matrix3().setFromMatrix4(node.matrixWorld).invert()
    for (const range of ranges) {
      for (let vertex = range.start; vertex < range.start + range.count; vertex++) {
        SkinnedMesh.prototype.getVertexPosition
          .call(node, vertex, point)
          .applyMatrix4(node.matrixWorld)
        correction.set(0, 0, 0)
        const height = ground(point.x, point.y, point.z, correction)
        correction.y += Math.max(0, height + 0.008 - point.y)
        for (let axis = 0; axis < 3; axis++) {
          const value = correction.getComponent(axis)
          const last = (old[vertex * 3 + axis] ?? 0) * 0.7
          correction.setComponent(
            axis,
            value * last < 0 || Math.abs(value) >= Math.abs(last) ? value : last,
          )
        }
        correction.clampLength(0, 0.55)
        old[vertex * 3] = correction.x
        old[vertex * 3 + 1] = correction.y
        old[vertex * 3 + 2] = correction.z
        correction.applyMatrix3(inverse)
        offset.setXYZ(vertex, correction.x, correction.y, correction.z)
      }
    }
  })
}

function countTransforms(run: () => void): number {
  const recursive = spyOn(Object3D.prototype, 'updateMatrixWorld')
  const worldOnly = spyOn(Object3D.prototype, 'updateWorldMatrix')
  try {
    run()
    return recursive.mock.calls.length + worldOnly.mock.calls.length
  } finally {
    recursive.mockRestore()
    worldOnly.mockRestore()
  }
}
