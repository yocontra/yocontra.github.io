/** Prepared sphere supports follow the real boot cloud instead of bone-axis box corners. */
import {
  type Bone,
  Box3,
  type BufferGeometry,
  Matrix3,
  Matrix4,
  type SkinnedMesh,
  Vector3,
} from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import { boneKey } from '../../scene/fit.ts'
import type { CorpseLink } from './crowd/corpse-rig.ts'

interface Support {
  center: Vector3
  radius: number
}
interface ShoeFrame {
  width: Vector3
  scale: Vector3
}
interface ShoeFit {
  supports: Support[]
  planes: { normal: Vector3; constant: number }[]
}
type Foot = 'FootL' | 'FootR'
const BOOT_MARGIN = 0.008
const cache = new WeakMap<BufferGeometry, Map<Foot, ShoeFit>>()
const measured = { prepared: 0, late: 0, milliseconds: 0 }
export const bootFitStats = () => ({ ...measured })
const directions: Vector3[] = []
for (let x = -2; x <= 2; x++) {
  for (let y = -2; y <= 2; y++) {
    for (let z = -2; z <= 2; z++) {
      const direction = new Vector3(x, y, z)
      if (direction.lengthSq() > 0) {
        directions.push(direction.normalize())
      }
    }
  }
}
const foot = (key: string): key is Foot => key === 'FootL' || key === 'FootR'
const unitScale = new Vector3(1, 1, 1)

function sphereBounds(supports: readonly Support[], scale: Vector3): Box3 {
  const bounds = new Box3()
  for (const support of supports) {
    const center = support.center.clone().multiply(scale)
    bounds.expandByPoint(center.clone().addScalar(-support.radius))
    bounds.expandByPoint(center.clone().addScalar(support.radius))
  }
  return bounds
}

function boundedRadius(support: Support, bounds: Box3, scale: Vector3): number {
  const { x, y, z } = support.center.clone().multiply(scale)
  return (
    Math.min(
      support.radius,
      x - bounds.min.x,
      y - bounds.min.y,
      z - bounds.min.z,
      bounds.max.x - x,
      bounds.max.y - y,
      bounds.max.z - z,
    ) - 1e-12
  )
}

function cloud(meshes: readonly SkinnedMesh[], bone: Bone, key: Foot): Vector3[] {
  const points: Vector3[] = []
  const inverse = bone.matrixWorld.clone().invert()
  const point = new Vector3()
  const side = key.endsWith('L') ? 'L' : 'R'
  for (const mesh of meshes) {
    const skin = mesh.geometry.getAttribute('skinIndex')
    const weights = mesh.geometry.getAttribute('skinWeight')
    const used = new Set(
      mesh.geometry.index?.array ?? Array.from({ length: skin.count }, (_, index) => index),
    )
    const keys = mesh.skeleton.bones.map((entry) => boneKey(entry.name))
    for (const vertex of used) {
      let shoe = 0
      for (let slot = 0; slot < 4; slot++) {
        const name = keys[skin.getComponent(vertex, slot)]
        if (name === `Foot${side}` || name === `Toe${side}`) {
          shoe += weights.getComponent(vertex, slot)
        }
      }
      // The sole/vamp is rigid to the foot. The ankle transition and calf shaft remain
      // covered by the adjacent lower-leg envelope instead of being frozen to the shoe.
      if (shoe < 1 - 1e-6) {
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

function candidatesFor(points: Vector3[], margin: number) {
  const hull = new ConvexHull().setFromPoints(points)
  const bounds = new Box3().setFromPoints(points)
  const size = bounds.getSize(new Vector3())
  const middle = bounds.getCenter(new Vector3())
  const candidates: Support[] = []
  const candidate = (center: Vector3, minimum = margin) => {
    const radius = Math.min(...hull.faces.map((face) => face.constant - face.normal.dot(center)))
    if (radius > minimum) {
      candidates.push({
        center,
        radius: radius + margin,
      })
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
  return {
    candidates,
    planes: hull.faces.map((face) => ({ normal: face.normal.clone(), constant: face.constant })),
  }
}

function seedSupports(candidates: Support[], points: Vector3[]): Support[] {
  const targets = Float64Array.from(directions, (direction) =>
    Math.max(...points.map((point) => point.dot(direction))),
  )
  const projections = candidates.map((support) =>
    Float64Array.from(directions, (direction) => support.center.dot(direction) + support.radius),
  )
  const covered = new Float64Array(directions.length).fill(Number.NEGATIVE_INFINITY)
  const selected = new Set<number>()
  for (let count = 0; count < 12; count++) {
    let best = -1
    let bestScore = Number.POSITIVE_INFINITY
    for (const [index, values] of projections.entries()) {
      if (selected.has(index)) {
        continue
      }
      let sum = 0
      let worst = 0
      for (let i = 0; i < covered.length; i++) {
        const gap =
          (targets[i] ?? 0) -
          Math.max(covered[i] ?? Number.NEGATIVE_INFINITY, values[i] ?? Number.NEGATIVE_INFINITY)
        sum += gap * gap
        worst = Math.max(worst, gap)
      }
      const score = worst * worst + sum / directions.length
      if (score < bestScore) {
        bestScore = score
        best = index
      }
    }
    const values = projections[best]
    if (!values) {
      break
    }
    selected.add(best)
    for (let i = 0; i < covered.length; i++) {
      covered[i] = Math.max(
        covered[i] ?? Number.NEGATIVE_INFINITY,
        values[i] ?? Number.NEGATIVE_INFINITY,
      )
    }
  }
  return [...selected].flatMap((index) => candidates[index] ?? [])
}

/** Keep the twelve established supports, with at most two missing lateral sole-rim contacts. */
export function bootSpheres(points: Vector3[], margin: number, frame?: ShoeFrame): Support[] {
  return shoeFit(points, margin, frame).supports
}

function shoeFit(points: Vector3[], margin: number, frame?: ShoeFrame): ShoeFit {
  if (points.length < 4) {
    return { supports: [], planes: [] }
  }
  const { candidates, planes } = candidatesFor(points, margin)
  const selected = seedSupports(candidates, points)
  if (frame) {
    selected.push(...lateralSupports(points, candidates, selected, { ...frame, margin }))
  }
  return { supports: selected.map(({ center, radius }) => ({ center, radius })), planes }
}

function lateralSupports(
  points: readonly Vector3[],
  candidates: readonly Support[],
  original: readonly Support[],
  frame: ShoeFrame & { margin: number },
): Support[] {
  const { margin } = frame
  const bounds = sphereBounds(original, frame.scale)
  const clipped = candidates.flatMap((support) => {
    // Keep Cannon's original identity-frame AABB, hence its mass inertia, exactly unchanged.
    const radius = boundedRadius(support, bounds, frame.scale)
    // A vanishing contact is smaller than the resolution of the existing skin margin.
    return radius > margin / 4 ? [{ center: support.center, radius }] : []
  })
  const added: Support[] = []
  for (const sign of [-1, 1]) {
    const direction = frame.width.clone().multiplyScalar(sign)
    const previous = Math.max(...original.map((s) => s.center.dot(direction) + s.radius))
    if (Math.max(...points.map((p) => p.dot(direction))) - previous <= margin) {
      continue
    }
    let value = previous + 1e-12
    let best: Support | undefined
    for (const support of clipped) {
      const next = support.center.dot(direction) + support.radius
      if (next > value) {
        value = next
        best = support
      }
    }
    if (best && !added.includes(best)) {
      added.push(best)
    }
  }
  return added
}

/** Only added rim contacts obey a fixed world margin; legacy supports stay untouched. */
function clipWorldMargin(
  supports: Support[],
  planes: ShoeFit['planes'],
  bone: Bone,
  link: CorpseLink,
) {
  const normalMatrix = new Matrix3().getNormalMatrix(bone.matrixWorld)
  const centers = supports.map((s) =>
    s.center.clone().applyQuaternion(link.rotation).add(link.position),
  )
  const normal = new Vector3()
  const anchor = new Vector3()
  const offset = new Vector3()
  for (const plane of planes) {
    normal.copy(plane.normal).applyMatrix3(normalMatrix).normalize()
    anchor.copy(plane.normal).multiplyScalar(plane.constant).applyMatrix4(bone.matrixWorld)
    for (const [index, support] of supports.entries()) {
      const center = centers[index]
      if (center) {
        const clearance = normal.dot(offset.copy(anchor).sub(center))
        // Skin and physics decompose imported transforms independently; keep a ten-nanometre
        // inward guard at the world hull boundary rather than enlarging the allowed margin.
        support.radius = Math.min(support.radius, clearance + BOOT_MARGIN - 1e-8)
      }
    }
  }
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
      const mesh = meshes[0]
      const inverse = mesh?.skeleton.boneInverses[mesh.skeleton.bones.indexOf(bone)]
      const frame =
        mesh && inverse
          ? {
              width: new Vector3(1, 0, 0).transformDirection(
                new Matrix4().multiplyMatrices(inverse, mesh.bindMatrix),
              ),
              scale: new Vector3(
                Math.abs(scale.x),
                Math.abs(scale.y),
                Math.abs(scale.z),
              ).divideScalar(radiusScale),
            }
          : undefined
      fits.set(link.key, shoeFit(cloud(meshes, bone, link.key), BOOT_MARGIN / radiusScale, frame))
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
    const fit = fits.get(link.key)
    if (!fit?.supports.length) {
      continue
    }
    const scale = bone.getWorldScale(new Vector3())
    scale.set(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))
    const radiusScale = Math.max(scale.x, scale.y, scale.z)
    link.anatomySpheres = fit.supports.map((support) => ({
      center: support.center.clone().multiply(scale),
      radius: support.radius * radiusScale,
    }))
    // Imported bone scales are slightly nonuniform, so their decomposed ratios vary with pose.
    // Reclip only the new contacts in the current mass frame; the original twelve stay exact.
    if (link.anatomySpheres.length > 12) {
      const bounds = sphereBounds(link.anatomySpheres.slice(0, 12), unitScale)
      clipWorldMargin(link.anatomySpheres.slice(12), fit.planes, bone, link)
      link.anatomySpheres = link.anatomySpheres.filter((support, supportIndex) => {
        if (supportIndex < 12) {
          return true
        }
        support.radius = boundedRadius(support, bounds, unitScale)
        return support.radius > BOOT_MARGIN / 4
      })
    }
  }
}
