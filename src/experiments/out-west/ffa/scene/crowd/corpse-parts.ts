/** Measured physical links for the same skeleton that skins the dressed player. */
import {
  Bone,
  type BufferGeometry,
  type Group,
  Matrix4,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three'
import { boneKey } from '../../../scene/fit.ts'
import type { CorpseBone, CorpseLink } from './corpse-rig.ts'

const TIPS: Readonly<Record<CorpseBone, string>> = {
  Hips: 'Abdomen',
  Abdomen: 'Torso',
  Torso: 'Chest',
  Chest: 'Neck',
  Neck: 'Head',
  Head: '',
  UpperArmL: 'LowerArmL',
  LowerArmL: 'WristL',
  WristL: 'Middle2L',
  UpperArmR: 'LowerArmR',
  LowerArmR: 'WristR',
  WristR: 'Middle2R',
  UpperLegL: 'LowerLegL',
  LowerLegL: 'FootL',
  FootL: 'ToeL',
  UpperLegR: 'LowerLegR',
  LowerLegR: 'FootR',
  FootR: 'ToeR',
}
const MASSES: Readonly<Record<CorpseBone, number>> = {
  Hips: 12,
  Abdomen: 5,
  Torso: 7,
  Chest: 9,
  Neck: 1,
  Head: 5,
  UpperArmL: 2.2,
  LowerArmL: 1.4,
  WristL: 0.6,
  UpperArmR: 2.2,
  LowerArmR: 1.4,
  WristR: 0.6,
  UpperLegL: 7,
  LowerLegL: 3.5,
  FootL: 1,
  UpperLegR: 7,
  LowerLegR: 3.5,
  FootR: 1,
}
interface LocalFit {
  radius: number
  center?: Vector3 | undefined
  halfExtents?: Vector3 | undefined
}
const positiveScale = (bone: Bone | undefined): Vector3 => {
  const scale = bone?.getWorldScale(new Vector3()) ?? new Vector3(1, 1, 1)
  return scale.set(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))
}
const fitCache = new WeakMap<BufferGeometry, Map<CorpseBone, LocalFit>>()
const percentile = (values: number[], fallback: number): number => {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length * 0.82)] ?? fallback
}
export function physicalParts(
  root: Group,
  meshes: SkinnedMesh[],
  keys: readonly CorpseBone[],
): { links: CorpseLink[]; bones: Bone[] } {
  const all = new Map<string, Bone>()
  root.traverse((node) => {
    if (node instanceof Bone) {
      all.set(boneKey(node.name), node as Bone)
    }
  })
  const bones = keys.flatMap((key) => {
    const bone = all.get(key)
    return bone ? [bone] : []
  })
  const indices = new Map(bones.map((bone, i) => [bone, i]))
  const rests = restFrames(meshes)
  const links: CorpseLink[] = bones.map((bone) => {
    const key = boneKey(bone.name) as CorpseBone
    const start = bone.getWorldPosition(new Vector3())
    const rotation = bone.getWorldQuaternion(new Quaternion())
    const tip = all.get(TIPS[key])
    const end =
      tip?.getWorldPosition(new Vector3()) ??
      start.clone().add(new Vector3(0, key === 'Head' ? 0.16 : 0.1, 0).applyQuaternion(rotation))
    let parent = bone.parent
    while (parent && !indices.has(parent as Bone)) {
      parent = parent.parent
    }
    const rest = rests.get(key)
    const restEnd = rests.get(TIPS[key])?.position
    return {
      key,
      parent: parent ? (indices.get(parent as Bone) ?? -1) : -1,
      position: start.clone(),
      rotation,
      start,
      end,
      radius: Math.max(0.025, Math.min(0.11, start.distanceTo(end) * 0.22)),
      mass: MASSES[key],
      ...(rest
        ? {
            restPosition: rest.position.clone(),
            restRotation: rest.rotation.clone(),
            restEnd:
              restEnd?.clone() ??
              end
                .clone()
                .sub(start)
                .applyQuaternion(rotation.clone().invert())
                .applyQuaternion(rest.rotation)
                .add(rest.position),
            forward: new Vector3(0, 0, 1).transformDirection(
              meshes[0]?.matrixWorld ?? new Matrix4(),
            ),
          }
        : {}),
    }
  })
  const cached = meshes[0] ? fitCache.get(meshes[0].geometry) : undefined
  if (cached) {
    for (const [i, link] of links.entries()) {
      const fit = cached.get(link.key)
      const scale = positiveScale(bones[i])
      if (fit) {
        link.radius = fit.radius * Math.max(scale.x, scale.y, scale.z)
        if (fit.center && fit.halfExtents) {
          link.center = fit.center.clone().multiply(scale)
          link.halfExtents = fit.halfExtents.clone().multiply(scale)
        }
      }
    }
  } else {
    measureParts(meshes, bones, links)
    const fits = new Map<CorpseBone, LocalFit>()
    for (const [i, link] of links.entries()) {
      const scale = positiveScale(bones[i])
      fits.set(link.key, {
        radius: link.radius / Math.max(scale.x, scale.y, scale.z),
        center: link.center?.clone().divide(scale),
        halfExtents: link.halfExtents?.clone().divide(scale),
      })
    }
    if (meshes[0]) {
      fitCache.set(meshes[0].geometry, fits)
    }
  }
  return { links, bones }
}

function dominantLink(
  mesh: SkinnedMesh,
  vertex: number,
  indices: Map<Bone, number>,
): number | undefined {
  const weights = mesh.geometry.getAttribute('skinWeight')
  const skin = mesh.geometry.getAttribute('skinIndex')
  let dominant = 0
  for (let j = 1; j < 4; j++) {
    if (weights.getComponent(vertex, j) > weights.getComponent(vertex, dominant)) {
      dominant = j
    }
  }
  let bone = mesh.skeleton.bones[skin.getComponent(vertex, dominant)]
  while (bone && !indices.has(bone)) {
    bone = bone.parent as Bone | undefined
  }
  return bone ? indices.get(bone) : undefined
}
function measureParts(meshes: SkinnedMesh[], bones: Bone[], links: CorpseLink[]): void {
  const indices = new Map(bones.map((bone, i) => [bone, i]))
  const radii = links.map(() => [] as number[])
  const local = links.map(() => [] as Vector3[])
  const p = new Vector3()
  const d = new Vector3()
  for (const mesh of meshes) {
    const weights = mesh.geometry.getAttribute('skinWeight')
    const ranges = mesh.geometry.userData.anatomyRanges as
      | { start: number; count: number }[]
      | undefined
    for (let vertex = 0; vertex < weights.count; vertex++) {
      if (
        ranges &&
        !ranges.some((range) => vertex >= range.start && vertex < range.start + range.count)
      ) {
        continue
      }
      const linkIndex = dominantLink(mesh, vertex, indices)
      const link = linkIndex === undefined ? undefined : links[linkIndex]
      if (!(link && linkIndex !== undefined)) {
        continue
      }
      mesh.getVertexPosition(vertex, p).applyMatrix4(mesh.matrixWorld)
      d.subVectors(link.end, link.start)
      const length = d.length()
      d.normalize()
      const along = p.clone().sub(link.start).dot(d)
      if (
        !['Head', 'FootL', 'FootR', 'WristL', 'WristR'].includes(link.key) &&
        (along < -length * 0.2 || along > length * 1.2)
      ) {
        continue
      }
      const radius = p.distanceTo(link.start.clone().addScaledVector(d, along))
      radii[linkIndex]?.push(radius)
      local[linkIndex]?.push(
        p.clone().sub(link.start).applyQuaternion(link.rotation.clone().invert()),
      )
    }
  }
  fitBounds(links, radii, local)
}
function fitBounds(links: CorpseLink[], radii: number[][], local: Vector3[][]): void {
  for (const [i, link] of links.entries()) {
    link.radius = Math.max(
      0.025,
      Math.min(link.key === 'Head' ? 0.14 : 0.18, percentile(radii[i] ?? [], link.radius)),
    )
    if (
      ['Hips', 'Abdomen', 'Torso', 'Chest', 'Head', 'FootL', 'FootR', 'WristL', 'WristR'].includes(
        link.key,
      )
    ) {
      const samples = local[i] ?? []
      const low = new Vector3()
      const high = new Vector3()
      for (let axis = 0; axis < 3; axis++) {
        const values = samples.map((point) => point.getComponent(axis)).sort((a, b) => a - b)
        low.setComponent(
          axis,
          values[
            Math.floor(
              values.length *
                (['Head', 'FootL', 'FootR', 'WristL', 'WristR'].includes(link.key) ? 0 : 0.05),
            )
          ] ?? -link.radius,
        )
        high.setComponent(
          axis,
          values[
            Math.min(
              values.length - 1,
              Math.floor(
                values.length *
                  (['Head', 'FootL', 'FootR', 'WristL', 'WristR'].includes(link.key) ? 1 : 0.95),
              ),
            )
          ] ?? link.radius,
        )
      }
      link.center = low.clone().add(high).multiplyScalar(0.5)
      link.halfExtents = high
        .sub(low)
        .multiplyScalar(0.5)
        .max(new Vector3(0.025, 0.025, 0.025))
    }
  }
}

/** Inverse binds record the neutral dressed skeleton; animation cannot redefine joint rest axes. */
function restFrames(
  meshes: SkinnedMesh[],
): Map<string, { position: Vector3; rotation: Quaternion }> {
  const result = new Map<string, { position: Vector3; rotation: Quaternion }>()
  for (const mesh of meshes) {
    const hierarchy = mesh.geometry.userData.restFrames as
      | { key: string; matrix: number[] }[]
      | undefined
    for (const frame of hierarchy ?? []) {
      const matrix = mesh.matrixWorld.clone().multiply(new Matrix4().fromArray(frame.matrix))
      const position = new Vector3()
      const rotation = new Quaternion()
      matrix.decompose(position, rotation, new Vector3())
      result.set(frame.key, { position, rotation })
    }

    const world = mesh.matrixWorld.clone().multiply(mesh.bindMatrix.clone().invert())
    for (const [i, bone] of mesh.skeleton.bones.entries()) {
      const inverse = mesh.skeleton.boneInverses[i]
      if (!inverse) {
        continue
      }
      const matrix = world.clone().multiply(inverse.clone().invert())
      const position = new Vector3()
      const rotation = new Quaternion()
      matrix.decompose(position, rotation, new Vector3())
      const key = boneKey(bone.name)
      if (!result.has(key)) {
        result.set(key, { position, rotation })
      }
    }
  }
  return result
}
