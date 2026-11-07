import { beforeAll, expect, it } from 'bun:test'
import { file } from 'bun'
import { Bone, Group, Matrix4, type Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three'
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

function drivers(rig: CorpseRig): Bone[] {
  const found = new Map<string, Bone>()
  rig.root.traverse((node) => {
    if (node instanceof Bone) {
      found.set(boneKey(node.name), node)
    }
  })
  return rig.links.map((link) => {
    const bone = found.get(link.key)
    if (!bone) {
      throw new Error(`Missing physical bone ${link.key}`)
    }
    return bone
  })
}

const transform = (node: Object3D): number[] => [
  ...node.position.toArray(),
  ...node.quaternion.toArray(),
  ...node.scale.toArray(),
]

/** Negative control: the former rotation-only children omit real solver-origin separation. */
function previousPose(rig: CorpseRig, bones: Bone[], poses: CorpsePose[]): void {
  const inverse = new Quaternion()
  for (const [i, bone] of bones.entries()) {
    const pose = poses[i]
    if (!pose) {
      throw new Error('Missing physical target')
    }
    bone.parent?.updateWorldMatrix(true, false)
    if (rig.links[i]?.parent === -1) {
      bone.position.copy(pose.position)
      bone.parent?.worldToLocal(bone.position)
    }
    inverse.identity()
    bone.parent?.getWorldQuaternion(inverse)
    bone.quaternion.copy(inverse.invert().multiply(pose.rotation))
    bone.updateMatrixWorld(true)
  }
  rig.root.updateMatrixWorld(true)
}

function rigidFeet(rig: CorpseRig, bones: Bone[]) {
  const samples: { mesh: SkinnedMesh; vertex: number; driver: number; offset: Vector3 }[] = []
  rig.root.traverse((node) => {
    if (!(node instanceof SkinnedMesh)) {
      return
    }
    const g = node.geometry
    const skin = g.getAttribute('skinIndex')
    const weights = g.getAttribute('skinWeight')
    const keys = node.skeleton.bones.map((bone) => boneKey(bone.name))
    const used = new Set<number>(g.index?.array ?? Array.from({ length: skin.count }, (_, i) => i))
    for (const vertex of used) {
      for (let slot = 0; slot < 4; slot++) {
        const key = keys[skin.getComponent(vertex, slot)]
        if (
          !((key === 'FootL' || key === 'FootR') && weights.getComponent(vertex, slot) >= 1 - 1e-6)
        ) {
          continue
        }
        const driver = rig.links.findIndex((link) => link.key === key)
        const bone = bones[driver]
        if (!bone) {
          throw new Error('Missing rigid foot')
        }
        const point = node.getVertexPosition(vertex, new Vector3()).applyMatrix4(node.matrixWorld)
        const offset = point
          .applyMatrix4(new Matrix4().copy(bone.matrixWorld).invert())
          .multiply(bone.getWorldScale(new Vector3()))
        samples.push({ mesh: node, vertex, driver, offset })
      }
    }
  })
  return samples
}

it.each(bases)(
  'maps every actual %s physical origin and rigid foot to its supplied world frame',
  (base) => {
    const model = models.get(base)
    if (!model) {
      throw new Error('Missing model')
    }
    const actor = dressedActor(model, revolverDef(0.32), {
      base,
      clips,
      outfit: 'outfit.gamblers-frock',
      gun: 'gun.hardins-pair',
      hat: 'hat.bronze-band',
      spurs: 'spurs.silver-jinglebobs',
      extra: 'extra.tin-star',
      seed: 'independent-mapping',
    })
    new Group().add(actor.root)
    actor.root.scale.setScalar(1.25)
    actor.root.rotation.set(0.09, 0.57, -0.08)
    actor.root.position.set(0.4, 1.3, -0.7)
    actor.play('Idle_Gun_Pointing', 0)
    actor.update(0.37)
    actor.root.updateMatrixWorld(true)
    const geometry = actor.meshes[0]?.geometry
    if (!geometry) {
      throw new Error('Missing actual geometry')
    }
    ownGeometry(geometry)
    const rig = cloneCorpse(actor, geometry, 'physical-mapping')
    const old = cloneCorpse(actor, geometry, 'old-mapping')
    try {
      const bones = drivers(rig)
      const physical = new Set<Object3D>(bones)
      const locals = new Map<Object3D, number[]>()
      const scales = bones.map((bone) => bone.scale.toArray())
      const samples = rigidFeet(rig, bones)
      const gear = new Set<string>()
      rig.root.traverse((node) => {
        if (!physical.has(node)) {
          locals.set(node, transform(node))
        }
        if (node.userData.corpseGear) {
          gear.add(node.userData.corpseGear)
        }
      })
      expect(bones).toHaveLength(18)
      expect(samples.length).toBeGreaterThan(0)
      expect(gear).toEqual(new Set(['hat', 'primary', 'offhand', 'spurs']))
      const turn = new Quaternion().setFromAxisAngle(new Vector3(0.2, 1, 0.3).normalize(), 0.47)
      const poses = rig.links.map((link, i) => ({
        position: link.position
          .clone()
          .applyQuaternion(turn)
          .add(new Vector3(0.7, 2.5, -0.6))
          .add(new Vector3(Math.sin(i) * 0.009, Math.cos(i) * 0.023, Math.sin(i * 2) * 0.007)),
        rotation: turn.clone().multiply(link.rotation),
      }))
      previousPose(old, drivers(old), poses)
      expect(
        Math.max(
          ...drivers(old).map((bone, i) => {
            const target = poses[i]
            if (!target) {
              throw new Error('Missing negative-control target')
            }
            return bone.getWorldPosition(new Vector3()).distanceTo(target.position)
          }),
        ),
      ).toBeGreaterThan(0.02)
      rig.pose(poses)
      for (const [i, bone] of bones.entries()) {
        const scale = scales[i]
        const target = poses[i]
        if (!(scale && target)) {
          throw new Error('Missing captured driver frame')
        }
        expect(bone.getWorldPosition(new Vector3()).distanceTo(target.position)).toBeLessThan(1e-9)
        const actualRotation = bone.getWorldQuaternion(new Quaternion()).normalize()
        expect(actualRotation.angleTo(target.rotation.clone().normalize())).toBeLessThan(1e-6)
        expect(bone.scale.toArray()).toEqual(scale)
      }
      for (const sample of samples) {
        const pose = poses[sample.driver]
        if (!pose) {
          throw new Error('Missing foot target')
        }
        const expected = sample.offset.clone().applyQuaternion(pose.rotation).add(pose.position)
        const actual = sample.mesh
          .getVertexPosition(sample.vertex, new Vector3())
          .applyMatrix4(sample.mesh.matrixWorld)
        expect(actual.distanceTo(expected)).toBeLessThan(1e-6)
      }
      for (const [node, local] of locals) {
        expect(transform(node)).toEqual(local)
      }
    } finally {
      rig.dispose()
      old.dispose()
      releaseGeometry(geometry)
      actor.dispose()
    }
  },
)
