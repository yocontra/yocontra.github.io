import { afterAll, beforeAll, expect, it } from 'bun:test'
import { file } from 'bun'
import { Sphere, World } from 'cannon-es'
import { Box3, Group, type Material, Mesh, type SkinnedMesh, Texture, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import type { Assets } from '../src/experiments/out-west/engine/assets.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { dressedRider } from '../src/experiments/out-west/ffa/scene/crowd/actor.ts'
import { CorpsePreparation } from '../src/experiments/out-west/ffa/scene/crowd/corpse-capture.ts'
import { cloneCorpse } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { bootSpheres } from '../src/experiments/out-west/ffa/scene/ragdoll-boot.ts'
import type { Actor } from '../src/experiments/out-west/scene/actor.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const models = new Map<string, GLTF>()
let assets: Assets
const texture = new Texture()
beforeAll(async () => {
  const load = async (base: string) => {
    const model = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${base}.glb`).arrayBuffer(), '')
    markCharacterSlots(model)
    return model
  }
  const player = await load('player')
  await Promise.all(bases.map(async (base) => models.set(base, await load(base))))
  assets = {
    player,
    props: player,
    tex: {
      ground: texture,
      groundN: texture,
      planks: texture,
      planksN: texture,
      vplanks: texture,
      vplanksN: texture,
      char: { map: texture, normal: texture, arm: texture },
    },
    bodyNow: (base) => models.get(base) ?? null,
    body: (base) => {
      const model = models.get(base)
      if (!model) {
        throw new Error('Missing actual body')
      }
      return Promise.resolve(model)
    },
    lookReady: async () => undefined,
    lookLoaded: () => true,
  }
})
afterAll(() => texture.dispose())

function freeFork(actor: Actor): void {
  const materials = new Set<Material>()
  actor.root.traverse((node) => {
    if (node instanceof Mesh) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(material)
      }
    }
  })
  actor.hat?.traverse((node) => {
    if (node instanceof Mesh) {
      node.geometry.dispose()
    }
  })
  for (const skin of actor.meshes) {
    releaseGeometry(skin.geometry)
  }
  for (const material of materials) {
    material.dispose()
  }
  actor.dispose()
}

it.each(bases)(
  'keeps new %s rim caps within eight world millimetres through prepared living forks',
  async (base) => {
    const preparation = new CorpsePreparation(assets)
    const look = lookFor(['outfit.trail-duds'], 16)
    look.look.base = base
    look.key += `/world-margin/${base}`
    await preparation.retain(look)
    const actor = preparation.fork(look)
    if (!actor) {
      throw new Error('Missing prepared living fork')
    }
    const holder = new Group()
    holder.scale.setScalar(1.25)
    holder.rotation.set(0.08, 0.63, -0.04)
    holder.add(actor.root)
    try {
      for (const clip of ['Idle', 'Idle_Gun_Pointing'] as const) {
        actor.play(clip, 0)
        actor.update(0.37)
        holder.updateMatrixWorld(true)
        const mesh = actor.meshes[0]
        if (!mesh) {
          throw new Error('Missing living fork skin')
        }
        const rig = cloneCorpse(actor, mesh.geometry, 'production-margin')
        const physics = new CorpsePhysics(new World(), rig, {
          velocity: new Vector3(),
          impulse: new Vector3(),
        })
        try {
          for (const sample of worldExcesses(physics, mesh)) {
            expect(
              sample.excess,
              `${base}/${clip}/${sample.key}/${sample.index}`,
            ).toBeLessThanOrEqual(0.008 + 1e-10)
          }
        } finally {
          physics.dispose()
        }
      }
    } finally {
      freeFork(actor)
      preparation.releaseUnused(new Set())
    }
  },
)

function worldExcesses(physics: CorpsePhysics, mesh: SkinnedMesh) {
  const samples: { key: string; index: number; excess: number }[] = []
  for (const part of physics.parts.filter((entry) => entry.link.key.startsWith('Foot'))) {
    const bone = mesh.skeleton.bones.find((entry) => boneKey(entry.name) === part.link.key)
    if (!bone) {
      throw new Error('Missing live foot')
    }
    const points = rigidPoints(mesh, part.link.key).map((p) => p.applyMatrix4(bone.matrixWorld))
    const hull = new ConvexHull().setFromPoints(points)
    const count = part.link.anatomySpheres?.length ?? 0
    for (let index = 12; index < count; index++) {
      const shape = part.body.shapes[index]
      const offset = part.body.shapeOffsets[index]
      if (!(shape instanceof Sphere && offset)) {
        throw new Error('Missing new rim sphere')
      }
      const world = part.body.pointToWorldFrame(offset)
      const center = new Vector3(world.x, world.y, world.z)
      for (const face of hull.faces) {
        if (face.normal.lengthSq() > 0) {
          samples.push({
            key: part.link.key,
            index,
            excess: face.normal.dot(center) + shape.radius - face.constant,
          })
        }
      }
    }
  }
  return samples
}

function rigidPoints(mesh: SkinnedMesh, key: string): Vector3[] {
  const foot = mesh.skeleton.bones.find((bone) => boneKey(bone.name) === key)
  if (!foot) {
    throw new Error('Missing actual foot')
  }
  const inverse = foot.matrixWorld.clone().invert()
  const indices = mesh.geometry.getAttribute('skinIndex')
  const weights = mesh.geometry.getAttribute('skinWeight')
  const points: Vector3[] = []
  for (const vertex of new Set(mesh.geometry.index?.array ?? [])) {
    let weight = 0
    for (let slot = 0; slot < 4; slot++) {
      const bone = mesh.skeleton.bones[indices.getComponent(vertex, slot)]
      if (bone && [key, key.replace('Foot', 'Toe')].includes(boneKey(bone.name))) {
        weight += weights.getComponent(vertex, slot)
      }
    }
    if (weight < 1 - 1e-6) {
      continue
    }
    const point = mesh
      .getVertexPosition(vertex, new Vector3())
      .applyMatrix4(mesh.matrixWorld)
      .applyMatrix4(inverse)
    if (!points.some((p) => p.distanceToSquared(point) < 1e-12)) {
      points.push(point)
    }
  }
  return points
}

interface Support {
  center: Vector3
  radius: number
}
function supportBounds(supports: readonly Support[]): Box3 {
  const box = new Box3()
  for (const support of supports) {
    box.expandByPoint(support.center.clone().addScalar(-support.radius))
    box.expandByPoint(support.center.clone().addScalar(support.radius))
  }
  return box
}

it.each(bases)(
  'keeps %s original supports and immutable shoe while bounding every added rim cap',
  (base) => {
    const look = lookFor(['outfit.trail-duds', 'spurs.silver-jinglebobs'], 1)
    look.look.base = base
    const actor = dressedRider(assets, look)
    const mesh = actor.meshes[0]
    if (!mesh) {
      throw new Error('Missing actual dressed skin')
    }
    const full = mesh.geometry
    const saved = ['position', 'normal', 'skinIndex', 'skinWeight'].map((key) =>
      full.getAttribute(key).array.slice(),
    )
    const savedIndex = full.index?.array.slice()
    ownGeometry(full)
    const rig = cloneCorpse(actor, full, 'sole-rim-invariants')
    try {
      let added = 0
      for (const key of ['FootL', 'FootR']) {
        const bone = mesh.skeleton.bones.find((b) => boneKey(b.name) === key)
        const link = rig.links.find((entry) => entry.key === key)
        if (!(bone && link?.anatomySpheres)) {
          throw new Error('Missing measured boot supports')
        }
        const scale = bone.getWorldScale(new Vector3())
        const factor = Math.max(scale.x, scale.y, scale.z)
        const points = rigidPoints(mesh, key)
        const old = bootSpheres(points, 0.008 / factor).map((s) => ({
          center: s.center.clone().multiply(scale),
          radius: s.radius * factor,
        }))
        const current = link.anatomySpheres
        expect(current.slice(0, 12)).toEqual(old)
        expect(current.length).toBeGreaterThanOrEqual(12)
        expect(current.length).toBeLessThanOrEqual(14)
        expect(supportBounds(current).equals(supportBounds(old))).toBe(true)
        const hull = new ConvexHull().setFromPoints(points)
        for (const support of current.slice(12)) {
          added++
          const center = support.center.clone().divide(scale)
          for (const face of hull.faces) {
            expect(
              face.normal.dot(center) + support.radius / factor - face.constant,
            ).toBeLessThanOrEqual(0.008 / factor + 1e-10)
          }
          expect(
            old.some((s) => s.center.equals(support.center) && s.radius === support.radius),
          ).toBe(false)
        }
        expect(new Set(current.map((s) => `${s.center.toArray()}/${s.radius}`)).size).toBe(
          current.length,
        )
        for (const face of hull.faces) {
          const projection = (s: Support) => s.center.dot(face.normal) + s.radius
          expect(Math.max(...current.map(projection))).toBeGreaterThanOrEqual(
            Math.max(...old.map(projection)),
          )
        }
      }
      expect(added).toBeLessThanOrEqual(4)
      for (const [index, key] of ['position', 'normal', 'skinIndex', 'skinWeight'].entries()) {
        const original = saved[index]
        if (!original) {
          throw new Error('Missing original attribute')
        }
        expect(full.getAttribute(key).array).toEqual(original)
      }
      expect(full.index?.array).toEqual(savedIndex)
    } finally {
      rig.dispose()
      releaseGeometry(full)
      actor.dispose()
    }
  },
)
