/** Independently posed clones of the actual dressed avatar; invisible physics bodies never render. */
import {
  type Box3,
  type BufferGeometry,
  Group,
  type Material,
  Mesh,
  type Quaternion,
  SkinnedMesh,
  Vector3,
} from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { Actor } from '../../../scene/actor.ts'
import { characterMaterial } from '../../../scene/shade.ts'
import { fitBoots } from '../ragdoll-boot.ts'
import { corpseBounds, prepareCorpseBounds } from './corpse-bounds.ts'
import { type CorpseGround, corpseCloth } from './corpse-cloth.ts'
import { clothPoints } from './corpse-cloth-points.ts'
import { copyRigidContacts, fitRigidContacts, warmRigidContacts } from './corpse-contacts.ts'
import { physicalParts } from './corpse-parts.ts'
import { corpsePose } from './corpse-pose.ts'
import { releaseGeometry, retainGeometry } from './geometry-lease.ts'

export type { CorpseGround } from './corpse-cloth.ts'

export const CORPSE_BONES = [
  'Hips',
  'Abdomen',
  'Torso',
  'Chest',
  'Neck',
  'Head',
  'UpperArmL',
  'LowerArmL',
  'WristL',
  'UpperArmR',
  'LowerArmR',
  'WristR',
  'UpperLegL',
  'LowerLegL',
  'FootL',
  'UpperLegR',
  'LowerLegR',
  'FootR',
] as const
export type CorpseBone = (typeof CORPSE_BONES)[number]
export interface CorpseLink {
  key: CorpseBone
  parent: number
  position: Vector3
  rotation: Quaternion
  start: Vector3
  end: Vector3
  radius: number
  mass: number
  restPosition?: Vector3
  restRotation?: Quaternion
  restEnd?: Vector3
  forward?: Vector3
  contacts?: { center: Vector3; radius: number }[]
  anatomySpheres?: { center: Vector3; radius: number }[]
  halfExtents?: Vector3
  center?: Vector3
}
export interface CorpsePose {
  position: Vector3
  rotation: Quaternion
}
export interface CorpseRig {
  identity: string
  sourceGeometry?: BufferGeometry
  lodSources?: ReadonlyMap<Mesh, BufferGeometry>
  velocity: Vector3
  root: Group
  links: CorpseLink[]
  floor: { value: number }
  bounds?: ((poses: readonly CorpsePose[]) => Box3) | undefined
  resetCloth?: (() => void) | undefined
  pose: (poses: readonly CorpsePose[], ground?: CorpseGround) => void
  dispose: () => void
}

/** Warm immutable bone-local measurements while the dressed actor is prepared, before a kill. */
export function prepareCorpseFit(actor: Actor): void {
  actor.root.updateMatrixWorld(true)
  const { links, bones } = physicalParts(actor.root, actor.meshes, CORPSE_BONES)
  fitBoots(actor.meshes, bones, links, true)
  warmRigidContacts(actor.root)
  for (const skin of actor.meshes) {
    clothPoints(skin, skin.geometry)
    prepareCorpseBounds(skin, bones)
  }
}

export function cloneCorpse(actor: Actor, full: BufferGeometry, identity: string): CorpseRig {
  actor.root.updateMatrixWorld(true)
  const cloned = cloneSkeleton(actor.root) as Group
  const sourceNodes: import('three').Object3D[] = []
  const clonedNodes: import('three').Object3D[] = []
  actor.root.traverse((node) => sourceNodes.push(node))
  cloned.traverse((node) => clonedNodes.push(node))
  const lookup = new Map(sourceNodes.map((node, i) => [node, clonedNodes[i]]))
  for (const [source, kind] of [
    [actor.hat, 'hat'],
    [actor.gun, 'primary'],
    [actor.offGun, 'offhand'],
    [actor.longHeld?.obj, 'long'],
  ] as const) {
    const gear = source ? lookup.get(source) : null
    if (gear) {
      gear.userData.corpseGear = kind
    }
  }
  const felt = new Set<import('three').Object3D>()
  actor.hat?.traverse((node) => {
    const clone = lookup.get(node)
    if (clone) {
      felt.add(clone)
    }
  })
  actor.root.matrixWorld.decompose(cloned.position, cloned.quaternion, cloned.scale)
  const root = new Group()
  root.name = 'dressed-corpse'
  root.add(cloned)
  const floor = { value: actor.root.getWorldPosition(new Vector3()).y }
  const ownedGeometry = new Set<BufferGeometry>()
  const sharedGeometry = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const skins: SkinnedMesh[] = []
  const lodSources = new Map<Mesh, BufferGeometry>()
  root.traverse((node) => {
    node.matrixAutoUpdate = true
    node.updateMatrix()
    if (!(node instanceof Mesh)) {
      return
    }
    node.customDepthMaterial = undefined
    node.customDistanceMaterial = undefined
    if (node instanceof SkinnedMesh) {
      lodSources.set(node, full)
      skins.push(node)
      if (!sharedGeometry.has(full)) {
        retainGeometry(full)
        sharedGeometry.add(full)
      }
      node.geometry = full
      node.material = characterMaterial(floor, 'CorpseCharacter', { value: 0 })
      node.skeleton.update = Object.getPrototypeOf(node.skeleton).update.bind(node.skeleton)
      node.bindMode = 'attached'
    } else {
      lodSources.set(node, node.geometry)
      const geometry = node.geometry.clone()
      copyRigidContacts(node.geometry, geometry)
      node.geometry = geometry
      ownedGeometry.add(node.geometry)
      const multiple = Array.isArray(node.material)
      const source = Array.isArray(node.material) ? node.material : [node.material]
      const copies = source.map((mat) => {
        if (felt.has(node)) {
          return characterMaterial(floor, 'CorpseFelt', { value: 0 })
        }
        const copy = mat.clone()
        // Live shoulder-camera thinning belongs to the living actor, never its corpse gear.
        copy.alphaHash = false
        copy.opacity = 1
        copy.onBeforeCompile = mat.onBeforeCompile
        copy.customProgramCacheKey = mat.customProgramCacheKey
        return copy
      })
      const single = copies[0]
      if (!single) {
        throw new Error('Corpse gear has no material')
      }
      node.material = multiple ? copies : single
    }
    for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(mat)
    }
    node.castShadow = true
    node.receiveShadow = true
    node.frustumCulled = false
  })
  for (const gun of [actor.gun, actor.offGun, actor.rifle]) {
    lookup.get(gun as import('three').Object3D)?.traverse((node) => {
      if (node instanceof Mesh) {
        node.visible = true
      }
    })
  }
  root.updateMatrixWorld(true)
  const long = actor.longHeld?.obj
  const held = long ? lookup.get(long) : null
  const wrist = actor.handR ? lookup.get(actor.handR) : null
  if (held && wrist && long?.visible) {
    wrist.attach(held)
  }
  root.updateMatrixWorld(true)
  const { links, bones } = physicalParts(root, skins, CORPSE_BONES)
  fitBoots(skins, bones, links)
  fitRigidContacts(root, bones, links)
  const cloth = skins.map((skin) => corpseCloth(skin, full))
  const updatePose = corpsePose(root, bones, links)
  const bounds = corpseBounds({ root, skins, full, bones, links })
  bounds(links)
  let disposed = false
  return {
    identity,
    sourceGeometry: full,
    lodSources,
    velocity: new Vector3(),
    root,
    links,
    floor,
    bounds,
    resetCloth: () => {
      for (const garment of cloth) {
        garment.reset()
      }
    },
    pose: (poses, ground) => {
      if (disposed) {
        return
      }
      updatePose(poses)
      bounds(poses)
      if (ground) {
        for (const garment of cloth) {
          garment.update(ground)
        }
      }
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      root.removeFromParent()
      lodSources.clear()
      for (const garment of cloth) {
        garment.dispose()
      }
      for (const skin of skins) {
        skin.skeleton.dispose()
      }
      for (const geometry of sharedGeometry) {
        releaseGeometry(geometry)
      }
      for (const geometry of ownedGeometry) {
        geometry.dispose()
      }
      for (const material of materials) {
        material.dispose()
      }
    },
  }
}
