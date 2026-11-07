import { beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import {
  Bone,
  Group,
  type Material,
  Mesh,
  type Object3D,
  SkinnedMesh,
  Texture,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Assets } from '../src/experiments/out-west/engine/assets.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { CorpsePreparation } from '../src/experiments/out-west/ffa/scene/crowd/corpse-capture.ts'
import {
  geometryReferences,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import { Actor, type Clip } from '../src/experiments/out-west/scene/actor.ts'
import {
  actorMaterialSource,
  ownPropMaterials,
} from '../src/experiments/out-west/scene/actor-template.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'
import { gunMaterial } from '../src/experiments/out-west/scene/gunsmith.ts'
import {
  equippedGun,
  fitCatalogSpurs,
  loadoutOpts,
} from '../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'
import { rifleObject } from '../src/experiments/out-west/scene/rifle.ts'

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
function rider(base: (typeof bases)[number]) {
  const model = models.get(base)
  if (!model) {
    throw new Error('Missing actual source')
  }
  const actor = new Actor(model, {
    ...loadoutOpts({
      outfit: base === 'woman' ? 'outfit.striped-poncho' : 'outfit.gamblers-frock',
      gun: 'gun.hardins-pair',
      hat: 'hat.bronze-band',
      extra: 'extra.red-bandana',
    }),
    base,
    clips,
    gun: equippedGun(revolverDef(0.32), 'gun.hardins-pair'),
    offGun: true,
    skin: 'brown',
    seed: 'exact-template',
  })
  fitCatalogSpurs(actor, 'spurs.silver-jinglebobs')
  return actor
}
function nodes(root: Object3D): Object3D[] {
  const result: Object3D[] = []
  root.traverse((node) => result.push(node))
  return result
}
function pose(actor: Actor, clip: Clip, time: number): void {
  actor.stopAll()
  const action = actor.play(clip, 0)
  if (action) {
    action.time = time
  }
  actor.mixer.update(0)
  actor.root.updateMatrixWorld(true)
  for (const mesh of actor.meshes) {
    mesh.skeleton.update()
  }
}
it.each(bases)('forks the exact dressed %s geometry, every posed vertex and attachment', (base) => {
  const source = rider(base)
  const template = source.template()
  const fork = new Actor(template)
  let error = 0
  const a = new Vector3()
  const b = new Vector3()
  for (const clip of ['Idle', 'Idle_Gun_Pointing', 'Run', 'Reload'] as const) {
    pose(source, clip, 0.37)
    pose(fork, clip, 0.37)
    const originalNodes = nodes(source.root)
    const forkNodes = nodes(fork.root)
    expect(forkNodes.length).toBe(originalNodes.length)
    for (const [index, node] of originalNodes.entries()) {
      const copy = forkNodes[index]
      if (!copy) {
        throw new Error('Missing fork node')
      }
      for (const [k, value] of node.matrixWorld.elements.entries()) {
        error = Math.max(error, Math.abs(value - (copy.matrixWorld.elements[k] ?? 0)))
      }
      if (node instanceof SkinnedMesh && copy instanceof SkinnedMesh) {
        for (let v = 0; v < node.geometry.getAttribute('position').count; v++) {
          node.getVertexPosition(v, a)
          copy.getVertexPosition(v, b)
          error = Math.max(error, a.distanceTo(b))
        }
      }
    }
  }
  for (const [index, mesh] of source.meshes.entries()) {
    const copy = fork.meshes[index]
    if (!copy) {
      throw new Error('Missing fork skin')
    }
    expect(copy.geometry).toBe(mesh.geometry)
    expect(copy.skeleton).not.toBe(mesh.skeleton)
    expect(copy.skeleton.bones[0]).not.toBe(mesh.skeleton.bones[0])
  }
  expect(error).toBeLessThan(1e-7)
  source.dispose()
  fork.dispose()
  for (const mesh of template.meshes) {
    mesh.skeleton.dispose()
  }
})

function material(actor: Actor): Material {
  const mesh = actor.meshes[0]
  if (!mesh || Array.isArray(mesh.material)) {
    throw new Error('Missing character material')
  }
  return mesh.material
}
it('keeps identical-look mixer clocks, bones, fades and shader uniforms independent of staging', () => {
  const source = rider('casual')
  const template = source.template()
  const first = new Actor(template)
  const second = new Actor(template)
  source.root.position.set(50, 9, -30)
  source.holsterGun()
  if (source.hat) {
    source.hat.visible = false
  }
  pose(source, 'Death', 0.9)
  pose(first, 'Reload', 0.8)
  pose(second, 'Run', 0.2)
  expect(first.mixer).not.toBe(second.mixer)
  expect(first.head).not.toBe(second.head)
  expect(first.drawing).not.toBe(second.drawing)
  expect(first.gestures).not.toBe(second.gestures)
  expect(first.root.position.length()).toBe(0)
  expect(first.hat?.visible).toBe(true)
  expect(first.action('Reload')?.time).toBe(0.8)
  expect(second.action('Run')?.time).toBe(0.2)
  const mat = material(first)
  mat.opacity = 0.2
  first.floor.value = 5
  first.glow.value = 0.7
  expect(material(second).opacity).toBe(1)
  expect(second.floor.value).toBe(0)
  expect(second.glow.value).toBe(0)
  for (const actor of [first, second]) {
    const shader = { uniforms: {}, vertexShader: '', fragmentShader: '' } as Parameters<
      Material['onBeforeCompile']
    >[0]
    material(actor).onBeforeCompile(shader, null as never)
    expect(shader.uniforms.styFloor).toBe(actor.floor)
    expect(shader.uniforms.styGlow).toBe(actor.glow)
  }
  const firstMeshes = nodes(first.root).filter((node): node is Mesh => node instanceof Mesh)
  const secondMeshes = nodes(second.root).filter((node): node is Mesh => node instanceof Mesh)
  expect(firstMeshes.length).toBe(secondMeshes.length)
  for (const [index, mesh] of firstMeshes.entries()) {
    expect(secondMeshes[index]?.material).not.toBe(mesh.material)
  }
  source.dispose()
  first.dispose()
  second.dispose()
  for (const mesh of template.meshes) {
    mesh.skeleton.dispose()
  }
})

function assets(lookReady: Assets['lookReady'] = async () => undefined): Assets {
  const player = models.get('casual')
  if (!player) {
    throw new Error('Missing loaded fixture')
  }
  const texture = new Texture()
  return {
    player: { ...player, animations: clips },
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
        throw new Error('Missing body')
      }
      return Promise.resolve(model)
    },
    lookLoaded: () => true,
    lookReady,
  }
}
function disposeFork(actor: Actor): void {
  const materials = new Set<Material>()
  actor.root.traverse((node) => {
    if (node instanceof Mesh) {
      for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(mat)
      }
    }
  })
  for (const mesh of actor.meshes) {
    releaseGeometry(mesh.geometry)
  }
  actor.hat?.traverse((node) => {
    if (node instanceof Mesh) {
      node.geometry.dispose()
    }
  })
  for (const mat of materials) {
    mat.dispose()
  }
  actor.dispose()
}

it.each(bases)(
  'prepares the actual %s sort sphere before any living fork can enter view',
  async (base) => {
    const prepared = new CorpsePreparation(assets())
    const look = lookFor(['outfit.gamblers-frock', 'gun.hardins-pair'], 800 + bases.indexOf(base))
    look.look.base = base
    const source = await prepared.retain(look)
    const first = prepared.fork(look)
    const second = prepared.fork(look)
    if (!(first && second)) {
      throw new Error('Missing prepared living forks')
    }
    try {
      for (const [index, mesh] of source.actor.meshes.entries()) {
        const a = first.meshes[index]
        const b = second.meshes[index]
        if (!(a && b)) {
          throw new Error('Missing prepared living skin')
        }
        expect(mesh.boundingSphere).not.toBeNull()
        // Compute the exact same-pose reference through Three's actual CPU skinning method.
        const expected = a.clone()
        expected.computeBoundingSphere()
        expect(a.boundingSphere?.equals(expected.boundingSphere)).toBe(true)
        expect(b.boundingSphere?.equals(expected.boundingSphere)).toBe(true)
        expect(a.boundingSphere).not.toBe(mesh.boundingSphere)
        expect(a.boundingSphere).not.toBe(b.boundingSphere)
        expect(a.geometry).toBe(mesh.geometry)
        expect(a.frustumCulled).toBe(false)
        const scan = spyOn(a, 'computeBoundingSphere')
        const saved = a.boundingSphere?.clone()
        for (const clip of ['Run', 'Reload', 'Idle_Gun_Pointing'] as const) {
          pose(first, clip, 0.37)
          // This is the renderer's sortObjects path, even though skin culling is disabled.
          if (a.boundingSphere === null) {
            a.computeBoundingSphere()
          }
          expect(a.frustumCulled).toBe(false)
        }
        expect(scan).not.toHaveBeenCalled()
        expect(a.boundingSphere?.equals(saved)).toBe(true)
        expect(first.mixer.time).toBe(0)
        expect(second.mixer.time).toBe(0)
        scan.mockRestore()
      }
    } finally {
      disposeFork(first)
      disposeFork(second)
      prepared.releaseUnused(new Set())
    }
  },
)

it('retains prepared sort spheres on local and shared cache hits without rescanning', async () => {
  const first = new CorpsePreparation(assets())
  const second = new CorpsePreparation(assets())
  const look = lookFor(['outfit.striped-poncho'], 890)
  const source = await first.retain(look)
  const mesh = source.actor.meshes[0]
  if (!mesh) {
    throw new Error('Missing prepared skin')
  }
  const scan = spyOn(mesh, 'computeBoundingSphere')
  const forks: Actor[] = []
  try {
    expect(await first.retain(look)).toBe(source)
    expect(await second.retain(look)).toBe(source)
    for (const owner of [first, second]) {
      const fork = owner.fork(look)
      if (!fork) {
        throw new Error('Missing cache-hit fork')
      }
      forks.push(fork)
      expect(fork.meshes[0]?.boundingSphere?.equals(mesh.boundingSphere)).toBe(true)
      expect(fork.meshes[0]?.boundingSphere).not.toBe(mesh.boundingSphere)
    }
    expect(forks[0]?.meshes[0]?.boundingSphere).not.toBe(forks[1]?.meshes[0]?.boundingSphere)
    expect(scan).not.toHaveBeenCalled()
  } finally {
    scan.mockRestore()
    for (const fork of forks) {
      disposeFork(fork)
    }
    first.releaseUnused(new Set())
    second.releaseUnused(new Set())
  }
})

it('keeps parked forks leased through template departure/reskin and restores a new life hat and pose', async () => {
  const prepared = new CorpsePreparation(assets())
  const look = lookFor(['outfit.striped-poncho', 'gun.hardins-pair', 'hat.bronze-band'], 601)
  const original = await prepared.retain(look)
  const first = prepared.fork(look)
  const second = prepared.fork(look)
  if (!(first && second && first.meshes[0])) {
    throw new Error('Prepared fork missing')
  }
  const full = first.meshes[0].geometry
  expect(geometryReferences(full)).toBe(3)
  const stage = new Group()
  stage.add(first.root)
  const detached = first.popHat()
  expect(first.hat).toBeNull()
  pose(first, 'Death', 0.9)
  first.gestures.talk = 1
  first.update(0.1)
  first.draw()
  prepared.reset(look, first)
  let resetError = 0
  first.root.traverse((node) => {
    if (node instanceof Bone) {
      const neutral = original.template.bones.get(boneKey(node.name))
      if (neutral) {
        resetError = Math.max(
          resetError,
          Math.abs(node.quaternion.x - neutral.quaternion.x),
          Math.abs(node.quaternion.y - neutral.quaternion.y),
          Math.abs(node.quaternion.z - neutral.quaternion.z),
          Math.abs(node.quaternion.w - neutral.quaternion.w),
        )
      }
    }
  })
  expect(resetError).toBeLessThan(1e-7)
  expect(first.gestures.talk).toBe(0)
  expect(first.drawing?.active).toBe(false)
  expect(first.hat).not.toBeNull()
  expect(first.hat).not.toBe(detached)
  expect(first.hat?.parent?.parent).toBe(first.head)
  expect(first.gun?.parent).toBe(first.holster)
  expect(first.offGun?.parent).toBe(first.offHolster)
  pose(first, 'Idle_Gun_Pointing', 0.2)
  let frees = 0
  full.addEventListener('dispose', () => {
    frees++
  })
  prepared.releaseUnused(new Set())
  expect(prepared.fork(look)).toBeNull()
  expect(prepared.stats.ready).toBe(0)
  expect(prepared.stats.pending).toBe(0)
  expect(geometryReferences(full)).toBe(2)
  expect(frees).toBe(0)
  const changed = lookFor(['outfit.gamblers-frock', 'gun.engraved-ivory'], 601)
  await prepared.retain(changed)
  const reskinned = prepared.fork(changed)
  if (!reskinned) {
    throw new Error('Reskinned fork missing')
  }
  expect(reskinned.meshes[0]?.geometry).not.toBe(full)
  expect(first.meshes[0].geometry).toBe(full)
  disposeFork(first)
  expect(frees).toBe(0)
  disposeFork(second)
  expect(frees).toBe(1)
  disposeFork(reskinned)
  prepared.releaseUnused(new Set())
})
it('never publishes an abandoned in-flight template and can prepare that appearance again', async () => {
  let entered: (() => void) | undefined
  const begun = new Promise<void>((resolve) => {
    entered = resolve
  })
  let resume: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  const prepared = new CorpsePreparation(
    assets(async () => {
      entered?.()
      await gate
    }),
  )
  const look = lookFor(['outfit.trail-duds'], 602)
  const pending = prepared.retain(look)
  await begun
  prepared.releaseUnused(new Set())
  resume?.()
  const abandoned = await pending
  expect(abandoned.actor.disposed).toBe(true)
  expect(prepared.stats.ready).toBe(0)
  expect(prepared.stats.pending).toBe(0)
  expect(prepared.fork(look)).toBeNull()
  await prepared.retain(look)
  const current = prepared.fork(look)
  expect(current).not.toBeNull()
  if (!current) {
    throw new Error('Reentry fork missing')
  }
  disposeFork(current)
  prepared.releaseUnused(new Set())
})

it('isolates late-added map weapon fades without splitting their immutable batch finish', () => {
  const first = rifleObject()
  const second = rifleObject()
  ownPropMaterials(first)
  ownPropMaterials(second)
  const mesh = (root: Object3D) => nodes(root).find((node): node is Mesh => node instanceof Mesh)
  const a = mesh(first)
  const b = mesh(second)
  if (!(a && b) || Array.isArray(a.material) || Array.isArray(b.material)) {
    throw new Error('Missing gun material')
  }
  expect(a.material).not.toBe(b.material)
  expect(a.material.onBeforeCompile).toBe(gunMaterial().onBeforeCompile)
  expect(actorMaterialSource(a.material)).toBe(gunMaterial())
  a.material.opacity = 0.1
  a.material.alphaHash = true
  expect(b.material.opacity).toBe(1)
  expect(gunMaterial().opacity).toBe(1)
  expect(gunMaterial().alphaHash).toBe(false)
})
