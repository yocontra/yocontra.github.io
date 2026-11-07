/** Prepared sphere supports follow the real boot cloud instead of bone-axis box corners. */
import { type Bone, Box3, type BufferGeometry, type SkinnedMesh, Vector3 } from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import { boneKey } from '../../scene/fit.ts'
import type { CorpseLink } from './crowd/corpse-rig.ts'

interface Support {
  center: Vector3
  radius: number
}
type Foot = 'FootL' | 'FootR'
const cache = new WeakMap<BufferGeometry, Map<Foot, Support[]>>()
const measured = { prepared: 0, late: 0, milliseconds: 0 }
export const bootFitStats = () => ({ ...measured })
const directions: Vector3[] = []
for (let x = -2; x <= 2; x++) {
  for (let y = -2; y <= 2; y++) {
    for (let z = -2; z <= 2; z++) {
      directions.push(new Vector3(x, y, z))
    }
  }
}
const unitDirections = directions
  .filter((value) => value.lengthSq() > 0)
  .map((value) => value.normalize())
const foot = (key: string): key is Foot => key === 'FootL' || key === 'FootR'

function cloud(meshes: readonly SkinnedMesh[], bone: Bone, key: Foot): Vector3[] {
  const points: Vector3[] = []
  const inverse = bone.matrixWorld.clone().invert()
  const point = new Vector3()
  const toe = key === 'FootL' ? 'ToeL' : 'ToeR'
  for (const mesh of meshes) {
    const skin = mesh.geometry.getAttribute('skinIndex')
    const weights = mesh.geometry.getAttribute('skinWeight')
    const used = new Set(
      mesh.geometry.index?.array ?? Array.from({ length: skin.count }, (_, index) => index),
    )
    const keys = mesh.skeleton.bones.map((entry) => boneKey(entry.name))
    for (const vertex of used) {
      let weight = 0
      for (let slot = 0; slot < 4; slot++) {
        const name = keys[skin.getComponent(vertex, slot)]
        if (name === key || name === toe) {
          weight += weights.getComponent(vertex, slot)
        }
      }
      if (weight <= 0.5) {
        continue
      }
      mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse)
      if (!points.some((value) => value.distanceToSquared(point) < 1e-12)) {
        points.push(point.clone())
      }
    }
  }
  return points
}

function supportError(support: Support, targets: number[], covered: number[]): number {
  let sum = 0
  let worst = 0
  for (const [index, direction] of unitDirections.entries()) {
    const gap =
      (targets[index] ?? 0) -
      Math.max(
        covered[index] ?? Number.NEGATIVE_INFINITY,
        support.center.dot(direction) + support.radius,
      )
    sum += gap * gap
    worst = Math.max(worst, gap)
  }
  return worst * worst + sum / unitDirections.length
}

/** A small prepared-only search. The hull bounds every sphere; no phantom box corners remain. */
export function bootSpheres(points: Vector3[], margin: number): Support[] {
  if (points.length < 4) {
    return []
  }
  const hull = new ConvexHull().setFromPoints(points)
  const bounds = new Box3().setFromPoints(points)
  const size = bounds.getSize(new Vector3())
  const middle = bounds.getCenter(new Vector3())
  const candidates: Support[] = []
  const candidate = (center: Vector3, minimum = margin) => {
    const radius = Math.min(...hull.faces.map((face) => face.constant - face.normal.dot(center)))
    if (radius > minimum) {
      candidates.push({ center, radius: radius + margin })
    }
  }
  for (let x = 0; x <= 8; x++) {
    for (let y = 0; y <= 8; y++) {
      for (let z = 0; z <= 8; z++) {
        candidate(new Vector3(x / 8, y / 8, z / 8).multiply(size).add(bounds.min))
      }
    }
  }
  // Surface-adjacent candidates cover the toe and heel without enlarging the whole foot.
  for (const point of points) {
    for (const toward of [0.03, 0.06, 0.1, 0.2, 0.4, 0.6]) {
      candidate(point.clone().lerp(middle, toward), 0)
    }
  }
  const targets = unitDirections.map((direction) =>
    Math.max(...points.map((point) => point.dot(direction))),
  )
  const covered = targets.map(() => Number.NEGATIVE_INFINITY)
  const result: Support[] = []
  for (let count = 0; count < 12; count++) {
    let selected: Support | undefined
    let best = Number.POSITIVE_INFINITY
    for (const support of candidates) {
      const score = supportError(support, targets, covered)
      if (score < best) {
        best = score
        selected = support
      }
    }
    if (!selected) {
      break
    }
    result.push(selected)
    const choice = selected
    for (const [i, direction] of unitDirections.entries()) {
      covered[i] = Math.max(
        covered[i] ?? Number.NEGATIVE_INFINITY,
        choice.center.dot(direction) + choice.radius,
      )
    }
    candidates.splice(candidates.indexOf(selected), 1)
  }
  return result
}

/** Measurement is cached by the immutable full dressed geometry while its look is prepared. */
export function fitBoots(
  meshes: readonly SkinnedMesh[],
  bones: readonly Bone[],
  links: readonly CorpseLink[],
  preparing = false,
): void {
  const geometry = meshes[0]?.geometry
  if (!geometry) {
    return
  }
  let fits = cache.get(geometry)
  if (!fits) {
    const started = performance.now()
    fits = new Map()
    for (const [index, link] of links.entries()) {
      const bone = bones[index]
      if (!(foot(link.key) && bone)) {
        continue
      }
      const scale = bone.getWorldScale(new Vector3())
      const radiusScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))
      fits.set(link.key, bootSpheres(cloud(meshes, bone, link.key), 0.008 / radiusScale))
    }
    cache.set(geometry, fits)
    measured[preparing ? 'prepared' : 'late']++
    measured.milliseconds += performance.now() - started
  }
  for (const [index, link] of links.entries()) {
    const bone = bones[index]
    if (!(foot(link.key) && bone)) {
      continue
    }
    const supports = fits.get(link.key)
    if (!supports?.length) {
      continue
    }
    const scale = bone.getWorldScale(new Vector3())
    scale.set(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))
    const radiusScale = Math.max(scale.x, scale.y, scale.z)
    link.anatomySpheres = supports.map((support) => ({
      center: support.center.clone().multiply(scale),
      radius: support.radius * radiusScale,
    }))
  }
}
