import { expect, it } from 'bun:test'
import { file } from 'bun'
import {
  Bone,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Scene,
  SkinnedMesh,
  SpriteMaterial,
  Texture,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { type Assets, markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Renderer } from '../src/experiments/out-west/engine/render.ts'
import { warmDrawables } from '../src/experiments/out-west/engine/warm.ts'
import { ViewModel } from '../src/experiments/out-west/ffa/client/viewmodel.ts'
import { VmSky } from '../src/experiments/out-west/ffa/client/vm-sky.ts'
import { warmViewModel } from '../src/experiments/out-west/ffa/client/vm-warm.ts'
import { lookFor, type PlayerLook } from '../src/experiments/out-west/ffa/scene/looks.ts'
import type { Actor } from '../src/experiments/out-west/scene/actor.ts'
import { gunMaterial } from '../src/experiments/out-west/scene/gunsmith.ts'

it('draws retained hand and hidden weapon nodes, restoring every flag even on failure', () => {
  const scene = new Scene()
  const parent = new Group()
  const material = new MeshStandardMaterial({ visible: false })
  const hand = new SkinnedMesh(undefined, material)
  const weapon = new Mesh(undefined, material)
  parent.visible = false
  weapon.visible = false
  weapon.frustumCulled = false
  parent.add(hand, weapon)
  scene.add(parent)
  const error = new Error('compile failure')
  expect(() =>
    warmViewModel(scene, () => {
      expect(parent.visible).toBe(true)
      expect(hand.visible).toBe(true)
      expect(weapon.visible).toBe(true)
      expect(hand.frustumCulled).toBe(false)
      expect(material.visible).toBe(true)
      throw error
    }),
  ).toThrow(error)
  expect(parent.visible).toBe(false)
  expect(hand.visible).toBe(true)
  expect(weapon.visible).toBe(false)
  expect(hand.frustumCulled).toBe(true)
  expect(weapon.frustumCulled).toBe(false)
  expect(material.visible).toBe(false)
  expect(material.opacity).toBe(1)
  expect(material.alphaHash).toBe(false)
  material.dispose()
  hand.geometry.dispose()
  weapon.geometry.dispose()
})

it('builds a pending actual look while third person stays selected, and warms each actor once', () => {
  let builds = 0
  let draws = 0
  const state = {
    pending: {} as object | null,
    actor: null as object | null,
    warmed: null as object | null,
    retiredSkin: new Set<MeshStandardMaterial>(),
    scene: new Scene(),
    on: false,
    build: () => {
      builds++
      state.pending = null
      state.actor = { root: new Group() }
    },
  }
  Object.setPrototypeOf(state, ViewModel.prototype)
  const warm = Reflect.get(ViewModel.prototype, 'warm')
  const draw = () => draws++
  Reflect.apply(warm, state, [draw])
  Reflect.apply(warm, state, [draw])
  expect(builds).toBe(1)
  expect(draws).toBe(1)
  expect(state.on).toBe(false)
  state.pending = {}
  Reflect.apply(warm, state, [draw])
  expect(builds).toBe(2)
  expect(draws).toBe(2)
  const previous = state.warmed
  state.pending = {}
  expect(() =>
    Reflect.apply(warm, state, [
      () => {
        throw new Error('retry')
      },
    ]),
  ).toThrow('retry')
  expect(state.warmed).toBe(previous)
  Reflect.apply(warm, state, [draw])
  expect(draws).toBe(3)
})

it('cancels a pending unloaded look when the authoritative look returns to the current actor', () => {
  const current = lookFor([], 1)
  const pending = lookFor(['outfit.gamblers-frock'], 1)
  const actor = { root: new Group() }
  let requested = 0
  const state = {
    assets: {
      bodyNow: () => null,
      body: () => {
        requested++
        return Promise.resolve()
      },
    },
    actor,
    warmed: actor,
    pending: null as PlayerLook | null,
    lookKey: current.key,
    on: true,
  }
  Object.setPrototypeOf(state, ViewModel.prototype)
  Reflect.apply(ViewModel.prototype.setLook, state, [pending])
  expect(requested).toBe(1)
  expect(state.pending).toBe(pending)
  Reflect.apply(ViewModel.prototype.setLook, state, [current])
  expect(state.pending).toBeNull()
  let draws = 0
  Reflect.apply(ViewModel.prototype.warm, state, [() => draws++])
  expect(requested).toBe(1)
  expect(state.actor).toBe(actor)
  expect(draws).toBe(0)
})

it('shares the camera-correct gun twin between actual paired weapons and releases warmed owned hats', async () => {
  const load = async (base: string) => {
    const model = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${base}.glb`).arrayBuffer(), '')
    markCharacterSlots(model)
    return model
  }
  const [model, player] = await Promise.all([load('casual'), load('player')])
  const assets = { player, bodyNow: () => model } as unknown as Assets
  const previous = Reflect.get(globalThis, 'document')
  Reflect.set(globalThis, 'document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  })
  const vm = new ViewModel(assets)
  const env = new Texture()
  const canonical = gunMaterial()
  let sourceReleased = 0
  const trackSource = () => sourceReleased++
  canonical.addEventListener('dispose', trackSource)
  const look = lookFor(['gun.hardins-pair'], 1)
  try {
    vm.townSky.update(env, 0.8, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7))
    vm.setLook(look)
    vm.warm(() => undefined)
    const actor = Reflect.get(vm, 'actor') as Actor
    const primary = firstMesh(actor.gun)
    const offhand = firstMesh(actor.offGun)
    expect(offhand.material).toBe(primary.material)
    expect(offhand.material).not.toBe(canonical)
    const material = offhand.material as MeshStandardMaterial
    vm.townSky.update(env, 0.8, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7))
    expect(material.envMap).toBe(env)
    expect(Math.abs(material.envMapRotation.y)).toBeGreaterThan(0.6)
    expect(canonical.envMap).toBeNull()
    const hat = firstMesh(actor.hat)
    let geometryReleased = 0
    let materialReleased = 0
    hat.geometry.addEventListener('dispose', () => geometryReleased++)
    const felt = hat.material as MeshStandardMaterial
    felt.addEventListener('dispose', () => materialReleased++)
    vm.setLook({ ...look, key: `${look.key}/replacement` })
    vm.warm(() => {
      expect(geometryReleased).toBe(1)
      expect(materialReleased).toBe(0)
    })
    expect(materialReleased).toBe(1)
    const replacement = Reflect.get(vm, 'actor') as Actor
    const finalHat = firstMesh(replacement.hat)
    let finalGeometryReleased = 0
    let finalMaterialReleased = 0
    finalHat.geometry.addEventListener('dispose', () => finalGeometryReleased++)
    ;(finalHat.material as MeshStandardMaterial).addEventListener(
      'dispose',
      () => finalMaterialReleased++,
    )
    vm.dispose()
    vm.dispose()
    expect(finalGeometryReleased).toBe(1)
    expect(finalMaterialReleased).toBe(1)
    expect(sourceReleased).toBe(0)
  } finally {
    vm.dispose()
    canonical.removeEventListener('dispose', trackSource)
    env.dispose()
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, 'document')
    } else {
      Reflect.set(globalThis, 'document', previous)
    }
  }
})

function firstMesh(root: Object3D | null): Mesh {
  let result: Mesh | undefined
  root?.traverse((node) => {
    if (!result && node instanceof Mesh) {
      result = node
    }
  })
  if (!result) {
    throw new Error('Missing actual rendered accessory')
  }
  return result
}

it('retains only the previous warmed skin programs through rapid replacement and retry', () => {
  const actor = () => {
    const root = new Group()
    const material = new MeshStandardMaterial()
    const mesh = new SkinnedMesh(undefined, material)
    const released = { geometry: 0, material: 0, actor: 0 }
    mesh.geometry.addEventListener('dispose', () => released.geometry++)
    material.addEventListener('dispose', () => released.material++)
    root.add(mesh)
    return {
      root,
      material,
      released,
      dispose: () => {
        released.actor++
        root.removeFromParent()
      },
    }
  }
  const first = actor()
  const state = {
    actor: first,
    warmed: first as typeof first | null,
    pending: null,
    retiredSkin: new Set<MeshStandardMaterial>(),
    sightGeometries: new Set<BufferGeometry>(),
    scene: new Scene(),
    fits: { revolver: null, rifle: null, shotgun: null },
    bones: new Map(),
  }
  Object.setPrototypeOf(state, ViewModel.prototype)
  state.scene.add(first.root)
  const clear = Reflect.get(ViewModel.prototype, 'clearBody')
  Reflect.apply(clear, state, [true])
  expect(first.released).toEqual({ geometry: 1, material: 0, actor: 1 })
  expect(state.retiredSkin.size).toBe(1)
  const intermediate = actor()
  state.actor = intermediate
  state.scene.add(intermediate.root)
  Reflect.apply(clear, state, [true])
  expect(intermediate.released).toEqual({ geometry: 1, material: 1, actor: 1 })
  expect(first.released.material).toBe(0)
  expect(state.retiredSkin.size).toBe(1)
  const last = actor()
  state.actor = last
  state.scene.add(last.root)
  const warm = Reflect.get(ViewModel.prototype, 'warm')
  expect(() =>
    Reflect.apply(warm, state, [
      () => {
        throw new Error('retry')
      },
    ]),
  ).toThrow('retry')
  expect(first.released.material).toBe(0)
  expect(state.retiredSkin.size).toBe(1)
  Reflect.apply(warm, state, [() => expect(first.released.material).toBe(0)])
  expect(first.released.material).toBe(1)
  expect(state.retiredSkin.size).toBe(0)
  expect(last.released.material).toBe(0)
  Reflect.apply(clear, state, [])
  expect(last.released).toEqual({ geometry: 1, material: 1, actor: 1 })
})

it('releases retired program references and owned flash resources on terminal teardown', () => {
  const skin = new MeshStandardMaterial()
  const texture = new Texture()
  const flash = new SpriteMaterial({ map: texture })
  const released = { skin: 0, texture: 0, flash: 0 }
  skin.addEventListener('dispose', () => released.skin++)
  texture.addEventListener('dispose', () => released.texture++)
  flash.addEventListener('dispose', () => released.flash++)
  const state = {
    actor: null,
    warmed: null,
    pending: {},
    retiredSkin: new Set([skin]),
    sightGeometries: new Set<BufferGeometry>(),
    fits: { revolver: null, rifle: null, shotgun: null },
    bones: new Map(),
    flash: { material: flash },
    townSky: new VmSky(),
  }
  Object.setPrototypeOf(state, ViewModel.prototype)
  Reflect.apply(ViewModel.prototype.dispose, state, [])
  Reflect.apply(ViewModel.prototype.dispose, state, [])
  let draws = 0
  Reflect.apply(ViewModel.prototype.warm, state, [() => draws++])
  expect(released).toEqual({ skin: 1, texture: 1, flash: 1 })
  expect(state.retiredSkin.size).toBe(0)
  expect(state.pending).toBeNull()
  expect(draws).toBe(0)
})

it('releases owned sky material twins while preserving shared textures and source materials', () => {
  const source = new MeshStandardMaterial({ name: 'GunLong' })
  const texture = new Texture()
  const mesh = new Mesh(undefined, source)
  const sky = new VmSky()
  sky.update(texture, 1, new Quaternion())
  sky.adopt(mesh)
  const twin = mesh.material
  let twinReleased = 0
  let sourceReleased = 0
  let textureReleased = 0
  twin.addEventListener('dispose', () => twinReleased++)
  source.addEventListener('dispose', () => sourceReleased++)
  texture.addEventListener('dispose', () => textureReleased++)
  expect(twin).not.toBe(source)
  sky.dispose()
  sky.dispose()
  expect(twinReleased).toBe(1)
  expect(sourceReleased).toBe(0)
  expect(textureReleased).toBe(0)
  mesh.geometry.dispose()
  source.dispose()
  texture.dispose()
})

it('releases the three locally allocated sight geometries on every replacement without shared gun disposal', () => {
  const shared = new BufferGeometry()
  const steel = new MeshStandardMaterial()
  let sharedReleased = 0
  let materialReleased = 0
  let sightReleased = 0
  const trackSight = () => sightReleased++
  shared.addEventListener('dispose', () => sharedReleased++)
  steel.addEventListener('dispose', () => materialReleased++)
  const state = {
    actor: null as object | null,
    sightGeometries: new Set<BufferGeometry>(),
    fits: { revolver: null, rifle: null, shotgun: null },
    paired: false,
    bones: new Map([['WristR', new Bone()]]),
  }
  Object.setPrototypeOf(state, ViewModel.prototype)
  for (let i = 0; i < 2; i++) {
    const root = new Group()
    root.add(new Mesh(shared, steel))
    state.bones.set('WristR', new Bone())
    const actor = {
      root,
      dispose: () => root.removeFromParent(),
      anatomy: {
        barrel: { cy: 0, hy: 0.01 },
        cylinder: { cy: 0, hy: 0.01 },
        muzzle: new Vector3(0.2, 0, 0),
        mouthX: 0,
        grip: new Vector3(),
      },
    }
    state.actor = actor
    Reflect.apply(Reflect.get(ViewModel.prototype, 'fitRevolver'), state, [actor, root])
    expect(state.sightGeometries.size).toBe(3)
    for (const geometry of state.sightGeometries) {
      geometry.addEventListener('dispose', trackSight)
    }
    Reflect.apply(Reflect.get(ViewModel.prototype, 'clearBody'), state, [])
    expect(state.sightGeometries.size).toBe(0)
  }
  expect(sightReleased).toBe(6)
  expect(sharedReleased).toBe(0)
  expect(materialReleased).toBe(0)
  shared.dispose()
  steel.dispose()
})

it('reflects both actual overlay output paths and restores the caller target after failure', () => {
  const original = {}
  const buffer = {}
  const scene = new Scene()
  const camera = {}
  let target: object | null = original
  const calls: (object | null)[] = []
  const state = {
    gl: {
      shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false },
      getRenderTarget: () => target,
      setRenderTarget: (value: object | null) => {
        target = value
      },
      compile: (actualScene: object, actualCamera: object) => {
        expect(actualScene).toBe(scene)
        expect(actualCamera).toBe(camera)
      },
      render: () => {
        calls.push(target)
        if (target === buffer) {
          throw new Error('restore')
        }
      },
    },
    composer: { inputBuffer: buffer },
  }
  expect(() => Reflect.apply(Renderer.prototype.warmSync, state, [scene, camera])).toThrow(
    'restore',
  )
  expect(calls).toEqual([null, buffer])
  expect(target).toBe(original)
})

it('warms actual off-camera shadow casters and restores culling and shadow policy on failure', () => {
  const scene = new Scene()
  const first = new Mesh()
  const second = new Mesh()
  first.castShadow = true
  second.frustumCulled = false
  second.visible = false
  scene.add(first, second)
  const shadows = { enabled: true, autoUpdate: false, needsUpdate: false }
  expect(() =>
    warmDrawables(scene, shadows, () => {
      expect(first.frustumCulled).toBe(false)
      expect(second.frustumCulled).toBe(false)
      expect(first.castShadow).toBe(true)
      expect(second.visible).toBe(false)
      expect(shadows.needsUpdate).toBe(true)
      shadows.autoUpdate = true
      throw new Error('driver')
    }),
  ).toThrow('driver')
  expect(first.frustumCulled).toBe(true)
  expect(second.frustumCulled).toBe(false)
  expect(shadows).toEqual({ enabled: true, autoUpdate: false, needsUpdate: false })
  shadows.enabled = false
  warmDrawables(scene, shadows, () => expect(shadows.needsUpdate).toBe(false))
  for (const mesh of [first, second]) {
    mesh.geometry.dispose()
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.dispose()
    }
  }
})
