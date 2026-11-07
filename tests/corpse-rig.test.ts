import { beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  SkinnedMesh,
  Texture,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  EF_HATLESS,
  EF_HOLSTERED,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
} from '../src/experiments/out-west/contract/town.ts'
import type { Assets } from '../src/experiments/out-west/engine/assets.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import {
  CorpsePreparation,
  corpsePreparationStats,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-capture.ts'
import {
  cloneCorpse,
  prepareCorpseFit,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  geometryReferences,
  ownGeometry,
  releaseGeometry,
  retainGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'
import { dressedActor } from '../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'
import { rifleObject } from '../src/experiments/out-west/scene/rifle.ts'

let source: GLTF
beforeAll(async () => {
  source = await new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(
      await file(
        new URL('../public/experiments/out-west/3d/models/player.glb', import.meta.url),
      ).arrayBuffer(),
      '',
    )
  markCharacterSlots(source)
})

it('leases shared immutable attributes across the original, LOD wrapper and corpse', () => {
  const full = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  )
  const lod = new BufferGeometry().setAttribute('position', full.getAttribute('position'))
  ownGeometry(full)
  ownGeometry(lod)
  retainGeometry(full)
  let frees = 0
  full.addEventListener('dispose', () => {
    frees++
  })
  lod.addEventListener('dispose', () => {
    frees++
  })
  releaseGeometry(lod)
  releaseGeometry(full)
  expect(frees).toBe(0)
  expect(geometryReferences(full)).toBe(1)
  releaseGeometry(full)
  expect(frees).toBe(2)
})

it.each(['outfit.striped-poncho', 'outfit.gamblers-frock'] as const)(
  'clones the actual %s skin, current pose and fitted gear with independent lifetime',
  (outfit) => {
    const actor = dressedActor(source, revolverDef(0.32), {
      outfit,
      gun: 'gun.hardins-pair',
      hat: 'hat.bronze-band',
      spurs: 'spurs.silver-jinglebobs',
    })
    const stage = new Group()
    stage.add(actor.root)
    actor.root.position.set(12, 6, 8)
    actor.root.rotation.y = 0.6
    actor.root.scale.setScalar(1.25)
    actor.draw()
    actor.play('Idle_Gun_Pointing', 0)
    actor.update(0.37)
    if (outfit === 'outfit.striped-poncho') {
      actor.holdLong(actor.addLong(rifleObject()))
      actor.update(0)
    }
    actor.gun?.traverse((node) => {
      if (node instanceof Mesh) {
        node.visible = false
      }
    })
    actor.root.updateMatrixWorld(true)
    const original = actor.meshes[0]
    if (!original) {
      throw new Error('Missing actual skin')
    }
    ownGeometry(original.geometry)
    const before = original.getVertexPosition(37, new Vector3()).applyMatrix4(original.matrixWorld)
    const rig = cloneCorpse(actor, original.geometry, 'life/actual-look')
    const skins: SkinnedMesh[] = []
    rig.root.traverse((node) => {
      if (node instanceof SkinnedMesh) {
        skins.push(node)
      }
    })
    const skin = skins[0]
    if (!skin) {
      throw new Error('Corpse replaced the actual skin')
    }
    expect(skin.geometry.getAttribute('position')).toBe(original.geometry.getAttribute('position'))
    expect(skin.skeleton).not.toBe(original.skeleton)
    expect(rig.lodSources?.get(skin)).toBe(original.geometry)
    const rigidSources = [...(rig.lodSources ?? [])].filter(
      ([mesh]) => !(mesh instanceof SkinnedMesh),
    )
    expect(rigidSources.length).toBeGreaterThan(0)
    expect(
      rigidSources.every(
        ([mesh, originalGeometry]) =>
          mesh.geometry.getAttribute('position') !== originalGeometry.getAttribute('position'),
      ),
    ).toBe(true)
    expect(
      skin.getVertexPosition(37, new Vector3()).applyMatrix4(skin.matrixWorld).distanceTo(before),
    ).toBeLessThan(0.000_01)
    const gears: Record<string, import('three').Object3D> = {}
    rig.root.traverse((node) => {
      if (node.userData.corpseGear) {
        gears[node.userData.corpseGear as string] = node
      }
    })
    expect(gears.hat).toBeDefined()
    expect(gears.primary).toBeDefined()
    expect(gears.offhand).toBeDefined()
    const gunMeshes: Mesh[] = []
    gears.primary?.traverse((node) => {
      if (node instanceof Mesh) {
        gunMeshes.push(node)
      }
    })
    expect(gunMeshes.every((mesh) => mesh.visible)).toBe(true)
    expect(
      gunMeshes.every((mesh) => !Array.isArray(mesh.material) || mesh.geometry.groups.length > 0),
    ).toBe(true)
    expect(gears.long?.parent?.name).toBe(
      outfit === 'outfit.striped-poncho' ? actor.handR?.name : undefined,
    )
    let freed = 0
    original.geometry.addEventListener('dispose', () => {
      freed++
    })
    releaseGeometry(original.geometry)
    actor.dispose()
    expect(freed).toBe(0)
    actor.floor.value = 999
    expect(rig.floor.value).toBe(6)
    const positions = rig.links.map((link) => ({
      position: link.position.clone().add(new Vector3(0, -0.2, 0)),
      rotation: link.rotation.clone(),
    }))
    rig.pose(positions)
    expect(rig.links.length).toBeGreaterThanOrEqual(16)
    expect(rig.links.every((link) => link.radius > 0 && Number.isFinite(link.mass))).toBe(true)
    expect(skin.getVertexPosition(37, new Vector3()).applyMatrix4(skin.matrixWorld).y).toBeCloseTo(
      before.y - 0.2,
      4,
    )
    rig.dispose()
    rig.dispose()
    expect(rig.lodSources?.size).toBe(0)
    expect(freed).toBe(1)
  },
)

it('does not inherit live shoulder-camera alpha thinning on corpse gear', () => {
  const actor = dressedActor(source, revolverDef(0.32), { gun: 'gun.hardins-pair' })
  const geometry = actor.meshes[0]?.geometry
  if (!geometry) {
    throw new Error('No dressed body')
  }
  const originalMaterials = new Map<
    import('three').Material,
    { opacity: number; alphaHash: boolean }
  >()
  actor.gun?.traverse((node) => {
    if (node instanceof Mesh) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        originalMaterials.set(material, {
          opacity: material.opacity,
          alphaHash: material.alphaHash,
        })
        material.alphaHash = true
        material.opacity = 0.15
      }
    }
  })
  ownGeometry(geometry)
  const rig = cloneCorpse(actor, geometry, 'camera-close-life')
  const primary: Mesh[] = []
  rig.root.traverse((node) => {
    if (node.userData.corpseGear === 'primary') {
      node.traverse((part) => {
        if (part instanceof Mesh) {
          primary.push(part)
        }
      })
    }
  })
  expect(primary.length).toBeGreaterThan(0)
  for (const mesh of primary) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      expect(material.alphaHash).toBe(false)
      expect(material.opacity).toBe(1)
    }
  }
  const sourceOpacity: number[] = []
  actor.gun?.traverse((node) => {
    if (node instanceof Mesh) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        sourceOpacity.push(material.opacity)
      }
    }
  })
  expect(sourceOpacity.length).toBeGreaterThan(0)
  expect(sourceOpacity.every((value) => value === 0.15)).toBe(true)
  for (const [material, original] of originalMaterials) {
    material.opacity = original.opacity
    material.alphaHash = original.alphaHash
  }
  rig.dispose()
  releaseGeometry(geometry)
  actor.dispose()
})

it('does not resurrect a hat already knocked off before the kill', () => {
  const actor = dressedActor(source, revolverDef(0.32), {})
  const stage = new Group()
  stage.add(actor.root)
  actor.popHat()
  const geometry = actor.meshes[0]?.geometry
  if (!geometry) {
    throw new Error('No dressed body')
  }
  ownGeometry(geometry)
  const rig = cloneCorpse(actor, geometry, 'hatless-life')
  const hats: unknown[] = []
  rig.root.traverse((node) => {
    if (node.userData.corpseGear === 'hat') {
      hats.push(node)
    }
  })
  expect(hats).toHaveLength(0)
  rig.dispose()
  releaseGeometry(geometry)
  actor.dispose()
})

it('uses warmed immutable anatomy without scanning skinned vertices during the kill', () => {
  const actor = dressedActor(source, revolverDef(0.32), { outfit: 'outfit.striped-poncho' })
  const skin = actor.meshes[0]
  if (!skin) {
    throw new Error('No skin')
  }
  ownGeometry(skin.geometry)
  prepareCorpseFit(actor)
  actor.root.scale.setScalar(1.25)
  actor.play('Walk', 0)
  actor.update(0.3)
  const scan = spyOn(SkinnedMesh.prototype, 'getVertexPosition')
  const rig = cloneCorpse(actor, skin.geometry, 'warmed')
  expect(scan).not.toHaveBeenCalled()
  scan.mockRestore()
  expect(rig.links.find((link) => link.key === 'Chest')?.halfExtents?.x).toBeLessThan(0.27)
  rig.dispose()
  releaseGeometry(skin.geometry)
  actor.dispose()
})

it('keeps a far real-body preparation leased through an overlapping roster departure', async () => {
  const assets = sourceAssets()
  const prepared = new CorpsePreparation(assets)
  const look = lookFor(['outfit.striped-poncho', 'gun.hardins-pair'], 27)
  await prepared.retain(look)
  expect(corpsePreparationStats().active).toBe(1)
  const capture = prepared.capture({
    identity: 'far-current-life',
    look,
    world: new Matrix4().makeScale(1.25, 1.25, 1.25).setPosition(3, 6, 9),
    clip: 'Walk_Aim',
    time: 0.35,
    flags: EF_HATLESS,
    weapon: WEAPON_RIFLE,
    velocity: new Vector3(1, -2, 0),
    attachments: { long: new Matrix4().makeRotationZ(0.4).setPosition(4, 7.4, 8) },
  })
  prepared.releaseUnused(new Set())
  const rig = await capture
  const gear: Record<string, import('three').Object3D> = {}
  rig.root.traverse((node) => {
    if (node.userData.corpseGear) {
      gear[node.userData.corpseGear as string] = node
    }
  })
  expect(gear.hat?.visible).toBe(false)
  expect(gear.long?.visible).toBe(true)
  expect(
    gear.long?.getWorldPosition(new Vector3()).distanceTo(new Vector3(4, 7.4, 8)),
  ).toBeLessThan(0.000_01)
  expect(gear.offhand).toBeDefined()
  expect(rig.velocity.y).toBe(-2)
  expect(corpsePreparationStats().active).toBe(0)
  expect(corpsePreparationStats().idle).toBe(0)
  expect(rig.sourceGeometry && geometryReferences(rig.sourceGeometry)).toBe(1)
  rig.dispose()
  expect(rig.sourceGeometry && geometryReferences(rig.sourceGeometry)).toBe(0)
})

it('conforms only real garment vertices to support while retaining immutable source attributes', () => {
  const actor = dressedActor(source, revolverDef(0.32), { outfit: 'outfit.striped-poncho' })
  actor.root.position.set(3, 6, 9)
  actor.root.scale.setScalar(1.25)
  actor.root.rotation.y = 0.7
  actor.root.updateMatrixWorld(true)
  const original = actor.meshes[0]
  if (!original) {
    throw new Error('No original skin')
  }
  ownGeometry(original.geometry)
  const ranges = original.geometry.userData.clothRanges as { start: number; count: number }[]
  expect(ranges.length).toBeGreaterThan(0)
  const sourcePositions = original.geometry.getAttribute('position')
  const first = sourcePositions.getY(0)
  const before = original.getVertexPosition(0, new Vector3()).applyMatrix4(original.matrixWorld)
  const rig = cloneCorpse(actor, original.geometry, 'cloth-plane')
  let skin: SkinnedMesh | undefined
  rig.root.traverse((node) => {
    if (node instanceof SkinnedMesh) {
      skin = node
    }
  })
  if (!skin) {
    throw new Error('No corpse skin')
  }
  rig.pose(
    rig.links.map((link) => ({ position: link.position, rotation: link.rotation })),
    () => 7.0,
  )
  let min = Number.POSITIVE_INFINITY
  for (const range of ranges) {
    for (let i = range.start; i < range.start + range.count; i++) {
      const p = skin.getVertexPosition(i, new Vector3()).applyMatrix4(skin.matrixWorld)
      min = Math.min(min, p.y)
    }
  }
  expect(min).toBeGreaterThan(6.99)
  expect(
    skin.getVertexPosition(0, new Vector3()).applyMatrix4(skin.matrixWorld).distanceTo(before),
  ).toBeLessThan(0.000_01)
  expect(sourcePositions.getY(0)).toBe(first)
  expect(skin.geometry.getAttribute('position')).toBe(sourcePositions)
  expect(skin.customDepthMaterial?.customProgramCacheKey()).toContain('corpse-cloth1')
  expect(skin.customDistanceMaterial?.customProgramCacheKey()).toContain('corpse-cloth1')
  rig.dispose()
  expect(original.geometry.getAttribute('position')).toBe(sourcePositions)
  releaseGeometry(original.geometry)
  actor.dispose()
})

function sourceAssets(): Assets {
  const texture = new Texture()
  return {
    props: source,
    tex: {
      ground: texture,
      groundN: texture,
      planks: texture,
      planksN: texture,
      vplanks: texture,
      vplanksN: texture,
      char: { map: texture, normal: texture, arm: texture },
    },
    lookLoaded: () => true,
    player: source,
    bodyNow: () => source,
    body: async () => source,
    lookReady: async () => undefined,
  }
}

it('keeps a far ADS primary on the hand even while the timer reports holstered', async () => {
  const prepared = new CorpsePreparation(sourceAssets())
  const look = lookFor(['outfit.shirt-vest', 'gun.engraved-ivory'], 28)
  await prepared.retain(look)
  const rig = await prepared.capture({
    identity: 'ads-holster-overlap',
    look,
    world: new Matrix4(),
    clip: 'Walk_Aim',
    time: 0.2,
    phase: 0.3,
    flags: EF_HOLSTERED,
    primarySocket: 'hand',
    weapon: WEAPON_REVOLVER,
    velocity: new Vector3(),
    attachments: { primary: new Matrix4().setPosition(0.3, 1.4, 0.5) },
  })
  const parents: import('three').Object3D[] = []
  rig.root.traverse((node) => {
    if (node.userData.corpseGear === 'primary' && node.parent) {
      parents.push(node.parent)
    }
  })
  let bone: import('three').Object3D | null = parents[0] ?? null
  while (bone && !(bone instanceof Bone)) {
    bone = bone.parent
  }
  expect(bone && boneKey(bone.name)).toBe('WristR')
  prepared.releaseUnused(new Set())
  rig.dispose()
})
