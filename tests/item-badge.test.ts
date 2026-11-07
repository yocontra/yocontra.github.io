import { expect, it } from 'bun:test'
import { file } from 'bun'
import { Group, PerspectiveCamera, SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { itemById } from '../src/experiments/out-west/data/catalog.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { cloneCorpse } from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'
import { badgeBounds } from '../src/experiments/out-west/scene/item-feature.ts'
import { ItemStudio } from '../src/experiments/out-west/scene/item-studio.ts'
import { dressedActor } from '../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'

it.each(['outfit.trail-duds', 'outfit.shirt-vest'] as const)(
  'frames and retains the actual beveled tin badge on %s and its corpse',
  async (outfit) => {
    const source = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file('public/experiments/out-west/3d/models/player.glb').arrayBuffer(), '')
    markCharacterSlots(source)
    const actor = dressedActor(source, revolverDef(0.32), { outfit, extra: 'extra.tin-star' })
    actor.holsterGun()
    actor.update(0.4)
    actor.root.rotation.y = 0.3
    new Group().add(actor.root)
    actor.root.updateMatrixWorld(true)
    const mesh = actor.meshes[0]
    const item = itemById('extra.tin-star')
    if (!(mesh && item)) {
      throw new Error('Missing actual badge')
    }
    const ranges = mesh.geometry.userData.badgeRanges as { start: number; count: number }[]
    const used = [...new Set(mesh.geometry.index?.array ?? [])].filter((vertex) =>
      ranges.some((range) => vertex >= range.start && vertex < range.start + range.count),
    )
    expect(used.length).toBeGreaterThan(60)
    const normals = mesh.geometry.getAttribute('normal')
    expect(
      new Set(used.map((vertex) => Math.round(normals.getZ(vertex) * 1000))).size,
    ).toBeGreaterThan(2)
    const indices = mesh.geometry.getAttribute('skinIndex')
    expect(
      used.every(
        (vertex) => boneKey(mesh.skeleton.bones[indices.getX(vertex)]?.name ?? '') === 'Chest',
      ),
    ).toBe(true)
    const camera = new PerspectiveCamera()
    const studio = Object.create(ItemStudio.prototype) as ItemStudio
    Reflect.set(studio, 'cam', camera)
    const frame = Reflect.get(studio, 'frameActor') as (
      subject: typeof actor,
      entry: typeof item,
    ) => void
    frame.call(studio, actor, item)
    const box = badgeBounds(actor)
    const middle = box.getCenter(new Vector3()).project(camera)
    const size = box.max.clone().project(camera).sub(box.min.clone().project(camera))
    expect(Math.abs(middle.x) + Math.abs(middle.y)).toBeLessThan(0.1)
    expect(Math.abs(size.x)).toBeGreaterThan(0.8)
    expect(Math.abs(size.y)).toBeGreaterThan(0.8)
    ownGeometry(mesh.geometry)
    const rig = cloneCorpse(actor, mesh.geometry, 'actual-badge')
    let clone: SkinnedMesh | undefined
    rig.root.traverse((node) => {
      if (node instanceof SkinnedMesh) {
        clone = node
      }
    })
    if (!clone) {
      throw new Error('Missing dressed corpse badge')
    }
    let error = 0
    for (const vertex of used) {
      error = Math.max(
        error,
        mesh
          .getVertexPosition(vertex, new Vector3())
          .applyMatrix4(mesh.matrixWorld)
          .distanceTo(
            clone.getVertexPosition(vertex, new Vector3()).applyMatrix4(clone.matrixWorld),
          ),
      )
    }
    expect(error).toBeLessThan(1e-6)
    expect(clone.geometry.getAttribute('position')).toBe(mesh.geometry.getAttribute('position'))
    rig.dispose()
    releaseGeometry(mesh.geometry)
    actor.dispose()
  },
)
