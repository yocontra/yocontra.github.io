/** Conservative skin/gear bounds from captured hierarchy and current physical bone frames. */
import {
  type Bone,
  Box3,
  type BufferGeometry,
  type Group,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  SkinnedMesh,
  Sphere,
  Vector3,
} from 'three'
import { CORPSE_CLOTH_LIMIT } from './corpse-cloth.ts'
import type { CorpseLink, CorpsePose } from './corpse-rig.ts'

interface Influence {
  bone: number
  point: Vector3
  weight: number
}
interface SkinBounds {
  bones: (Box3 | undefined)[]
  exact: Influence[][]
  minWeight: number
  maxWeight: number
  absoluteWeight: number
  signed: boolean
}
const cache = new WeakMap<BufferGeometry, SkinBounds>()
const unit = new Vector3(1, 1, 1)

/** Vertex scans occur during normal preparation; a kill transforms only cached envelopes. */
export function prepareCorpseBounds(
  mesh: SkinnedMesh,
  physicalBones: readonly Bone[],
  full: BufferGeometry = mesh.geometry,
): SkinBounds {
  const have = cache.get(full)
  if (have) {
    return have
  }
  const physical = new Map<Object3D, number>(physicalBones.map((bone, index) => [bone, index]))
  const movable = mesh.skeleton.bones.map((bone) => ancestorIndex(bone, physical) !== undefined)
  const bones: (Box3 | undefined)[] = []
  const exact: Influence[][] = []
  const position = full.getAttribute('position')
  const indices = full.getAttribute('skinIndex')
  const weights = full.getAttribute('skinWeight')
  const bind = mesh.skeleton.boneInverses.map((inverse) =>
    new Matrix4().multiplyMatrices(inverse, mesh.bindMatrix),
  )
  let minWeight = 1
  let maxWeight = 1
  let absoluteWeight = 1
  let signed = false
  const point = new Vector3()
  for (let vertex = 0; vertex < position.count; vertex++) {
    let total = 0
    let absoluteTotal = 0
    let fixed = false
    for (let slot = 0; slot < 4; slot++) {
      const weight = weights.getComponent(vertex, slot)
      const index = indices.getComponent(vertex, slot)
      total += weight
      absoluteTotal += Math.abs(weight)
      signed ||= weight < 0
      fixed ||= weight !== 0 && !movable[index]
    }
    const influences: Influence[] | undefined = fixed ? [] : undefined
    for (let slot = 0; slot < 4; slot++) {
      const weight = weights.getComponent(vertex, slot)
      const index = indices.getComponent(vertex, slot)
      const matrix = bind[index]
      if (weight === 0 || !matrix) {
        continue
      }
      point.fromBufferAttribute(position, vertex).applyMatrix4(matrix)
      if (influences) {
        influences.push({ bone: index, weight, point: point.clone() })
      } else {
        const box = bones[index] ?? new Box3()
        bones[index] = box
        box.expandByPoint(point)
      }
    }
    if (influences) {
      // Tiny imported Root weights must contribute exactly, not pin a whole unweighted box.
      exact.push(influences)
    }
    minWeight = Math.min(minWeight, total)
    maxWeight = Math.max(maxWeight, total)
    absoluteWeight = Math.max(absoluteWeight, absoluteTotal)
  }
  const result = { bones, exact, minWeight, maxWeight, absoluteWeight, signed }
  cache.set(full, result)
  return result
}
interface Options {
  root: Group
  skins: SkinnedMesh[]
  full: BufferGeometry
  bones: Bone[]
  links: CorpseLink[]
}
interface Envelope {
  bone: number
  box: Box3
}

export function corpseBounds({ root, skins, full, bones, links }: Options) {
  const indices = new Map<Object3D, number>(bones.map((bone, index) => [bone, index]))
  const inverse = links.map((link) =>
    new Matrix4().compose(link.position, link.rotation, unit).invert(),
  )
  const envelopes: Envelope[] = []
  const fixed = new Box3()
  const exact: Influence[][] = []
  let minWeight = 1
  let maxWeight = 1
  let absoluteWeight = 0
  let cloth = false
  const include = (node: Object3D, local: Box3) => {
    const index = ancestorIndex(node, indices)
    const transform = new Matrix4().copy(node.matrixWorld)
    if (index === undefined) {
      fixed.union(local.clone().applyMatrix4(transform))
      return
    }
    const frame = inverse[index]
    if (frame) {
      envelopes.push({ bone: index, box: local.clone().applyMatrix4(transform.premultiply(frame)) })
    }
  }
  for (const mesh of skins) {
    const prepared = prepareCorpseBounds(mesh, bones, full)
    minWeight = Math.min(minWeight, prepared.minWeight)
    maxWeight = Math.max(maxWeight, prepared.maxWeight)
    absoluteWeight = Math.max(absoluteWeight, prepared.signed ? prepared.absoluteWeight : 0)
    cloth ||= Boolean((full.userData.clothRanges as unknown[] | undefined)?.length)
    for (const [index, box] of prepared.bones.entries()) {
      const bone = mesh.skeleton.bones[index]
      if (bone && box) {
        include(bone, box)
      }
    }
    exact.push(
      ...prepared.exact.map((vertex) =>
        vertex.map((influence) => {
          const bone = mesh.skeleton.bones[influence.bone]
          const index = bone ? ancestorIndex(bone, indices) : undefined
          const point = influence.point.clone()
          if (bone) {
            point.applyMatrix4(bone.matrixWorld)
          }
          if (index !== undefined && inverse[index]) {
            point.applyMatrix4(inverse[index])
          }
          return { bone: index ?? -1, point, weight: influence.weight }
        }),
      ),
    )
    mesh.boundingBox = new Box3()
    mesh.boundingSphere = new Sphere()
    mesh.frustumCulled = true
  }
  root.traverse((node) => {
    if (!(node instanceof Mesh) || node instanceof SkinnedMesh || !visible(node, root)) {
      return
    }
    if (!node.geometry.boundingBox) {
      node.geometry.computeBoundingBox()
    }
    if (node.geometry.boundingBox) {
      include(node, node.geometry.boundingBox)
    }
    node.frustumCulled = true
  })
  const frames = linkFrames(links)
  for (const envelope of envelopes) {
    frames[envelope.bone]?.box.union(envelope.box)
  }
  const result = new Box3()
  const transformed = new Box3()
  const scratch = { point: new Vector3(), contribution: new Vector3() }
  const meshInverse = new Matrix4()
  const parentInverse = new Quaternion()
  const margin = cloth ? CORPSE_CLOTH_LIMIT : 0
  return (poses: readonly CorpsePose[]): Box3 => {
    result.copy(fixed)
    for (const [index, frame] of frames.entries()) {
      const pose = poses[index]
      if (pose) {
        frame.rotation.copy(pose.rotation)
      }
      const parent = frames[frame.link.parent]
      if (pose) {
        frame.position.copy(pose.position)
        if (parent) {
          frame.offset
            .copy(pose.position)
            .sub(parent.position)
            .applyQuaternion(parentInverse.copy(parent.rotation).invert())
        }
      } else if (parent) {
        frame.position.copy(frame.offset).applyQuaternion(parent.rotation).add(parent.position)
      }
      frame.matrix.compose(frame.position, frame.rotation, unit)
      if (!frame.box.isEmpty()) {
        result.union(transformed.copy(frame.box).applyMatrix4(frame.matrix))
      }
    }
    weightBounds(result, minWeight, maxWeight, absoluteWeight)
    exactBounds(result, exact, frames, scratch)
    result.expandByScalar(margin + 0.002)
    for (const mesh of skins) {
      meshInverse.copy(mesh.matrixWorld).invert()
      mesh.boundingBox?.copy(result).applyMatrix4(meshInverse)
      if (mesh.boundingSphere && mesh.boundingBox) {
        mesh.boundingBox.getBoundingSphere(mesh.boundingSphere)
      }
    }
    return result
  }
}
function exactBounds(
  result: Box3,
  exact: readonly Influence[][],
  frames: ReturnType<typeof linkFrames>,
  { point, contribution }: { point: Vector3; contribution: Vector3 },
): void {
  for (const vertex of exact) {
    point.set(0, 0, 0)
    for (const influence of vertex) {
      contribution.copy(influence.point)
      const frame = frames[influence.bone]
      if (frame) {
        contribution.applyMatrix4(frame.matrix)
      }
      point.addScaledVector(contribution, influence.weight)
    }
    result.expandByPoint(point)
  }
}
function linkFrames(links: readonly CorpseLink[]) {
  return links.map((link) => {
    const parent = links[link.parent]
    const offset = parent
      ? link.position.clone().sub(parent.position).applyQuaternion(parent.rotation.clone().invert())
      : link.position.clone()
    return {
      link,
      offset,
      position: link.position.clone(),
      rotation: link.rotation.clone(),
      matrix: new Matrix4(),
      box: new Box3(),
    }
  })
}
function ancestorIndex(node: Object3D, indices: ReadonlyMap<Object3D, number>): number | undefined {
  for (let current: Object3D | null = node; current; current = current.parent) {
    const index = indices.get(current)
    if (index !== undefined) {
      return index
    }
  }
  return undefined
}
function visible(node: Object3D, root: Group): boolean {
  for (let current: Object3D | null = node; current && current !== root; current = current.parent) {
    if (!current.visible) {
      return false
    }
  }
  return true
}
function weightBounds(box: Box3, min: number, max: number, absoluteWeight: number): void {
  if (box.isEmpty()) {
    return
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    const low = box.min[axis]
    const high = box.max[axis]
    if (absoluteWeight > 0) {
      const extent = Math.max(Math.abs(low), Math.abs(high)) * absoluteWeight
      box.min[axis] = -extent
      box.max[axis] = extent
    } else {
      box.min[axis] = Math.min(low * min, low * max, high * min, high * max)
      box.max[axis] = Math.max(low * min, low * max, high * min, high * max)
    }
  }
}
