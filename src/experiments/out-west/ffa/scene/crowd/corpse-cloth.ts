/** Garment-only support conformance; anatomy, source buffers and skeleton identity stay immutable. */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  type Material,
  Matrix3,
  Matrix4,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  RGBADepthPacking,
  type SkinnedMesh,
  Vector3,
} from 'three'
import { type ClothPoints, type ClothRange, clothPoints } from './corpse-cloth-points.ts'

export const CORPSE_CLOTH_LIMIT = 0.55

export type CorpseGround = (x: number, y: number, z: number, correction?: Vector3) => number
interface Cloth {
  reset: () => void
  update: (ground: CorpseGround) => void
  dispose: () => void
}
const shaderOffset = `attribute vec3 corpseOffset;
varying float vCorpseCorrection;
`
function displace(material: Material, shading: boolean): void {
  const compile = material.onBeforeCompile
  const key = material.customProgramCacheKey.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer)
    shader.vertexShader =
      shaderOffset +
      shader.vertexShader.replace(
        '#include <skinning_vertex>',
        '#include <skinning_vertex>\ntransformed += corpseOffset;\nvCorpseCorrection = length(corpseOffset);',
      )
    if (shading) {
      shader.fragmentShader = `varying float vCorpseCorrection;\n${shader.fragmentShader}`.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        vec3 contactNormal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))) * faceDirection;
        normal = normalize(mix(normal, contactNormal, smoothstep(0.003, 0.018, vCorpseCorrection)));`,
      )
    }
  }
  material.customProgramCacheKey = () => `${key()}/corpse-cloth1`
}

/** A wrapper owns offsets only: source attributes are detached before disposing that wrapper. */
export function corpseCloth(mesh: SkinnedMesh, full: BufferGeometry): Cloth {
  const ranges = full.userData.clothRanges as ClothRange[] | undefined
  if (!ranges?.length) {
    return { update: () => undefined, reset: () => undefined, dispose: () => undefined }
  }
  const geometry = new BufferGeometry()
  for (const [name, attribute] of Object.entries(full.attributes)) {
    geometry.setAttribute(name, attribute)
  }
  geometry.setIndex(full.index)
  geometry.userData = full.userData
  const offset = new BufferAttribute(new Float32Array(full.getAttribute('position').count * 3), 3)
  offset.setUsage(DynamicDrawUsage)
  geometry.setAttribute('corpseOffset', offset)
  mesh.geometry = geometry
  const basePosition = mesh.getVertexPosition
  mesh.getVertexPosition = (index, target) => {
    basePosition.call(mesh, index, target)
    target.x += offset.getX(index)
    target.y += offset.getY(index)
    target.z += offset.getZ(index)
    return target
  }
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    displace(material, true)
  }
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking })
  const distance = new MeshDistanceMaterial()
  displace(depth, false)
  displace(distance, false)
  mesh.customDepthMaterial = depth
  mesh.customDistanceMaterial = distance
  const contact = conformance(mesh, full, ranges, offset)
  return {
    ...contact,
    dispose: () => {
      for (const name of Object.keys(full.attributes)) {
        geometry.deleteAttribute(name)
      }
      geometry.setIndex(null)
      geometry.dispose()
      depth.dispose()
      distance.dispose()
    },
  }
}

function conformance(
  mesh: SkinnedMesh,
  full: BufferGeometry,
  ranges: ClothRange[],
  offset: BufferAttribute,
): Pick<Cloth, 'update' | 'reset'> {
  const points = clothPoints(mesh, full)
  const used = new Set(points.bones)
  const palette = new Array(mesh.skeleton.bones.length).fill(new Matrix4())
  const bones = [...used].flatMap((index) => {
    const bone = mesh.skeleton.bones[index]
    if (!bone) {
      return []
    }
    const matrix = new Matrix4()
    palette[index] = matrix
    return [{ bone, matrix }]
  })
  const previous = new Float32Array(points.count * 3)
  const correction = new Vector3()
  const p = new Vector3()
  const inverse = new Matrix3()
  const world = new Matrix4()
  const update: Cloth['update'] = (ground) => {
    world.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse)
    for (const { bone, matrix } of bones) {
      matrix.multiplyMatrices(world, bone.matrixWorld)
    }
    inverse.setFromMatrix4(mesh.matrixWorld).invert()
    for (let index = 0; index < points.count; index++) {
      skinnedPoint(index, points, palette, p)
      correction.set(0, 0, 0)
      const height = ground(p.x, p.y, p.z, correction)
      correction.y += Number.isFinite(height) ? Math.max(0, height + 0.008 - p.y) : 0
      releaseContact(previous, index, correction)
      p.copy(correction).applyMatrix3(inverse)
      for (
        let at = points.vertexStarts[index] ?? 0;
        at < (points.vertexStarts[index + 1] ?? 0);
        at++
      ) {
        offset.setXYZ(points.vertices[at] ?? 0, p.x, p.y, p.z)
      }
    }
    // Each update replaces every cloth offset, including writes pending while offscreen.
    offset.clearUpdateRanges()
    for (const range of ranges) {
      offset.addUpdateRange(range.start * 3, range.count * 3)
    }
    offset.needsUpdate = true
  }
  return { update, reset: () => previous.fill(0) }
}

function skinnedPoint(index: number, points: ClothPoints, palette: Matrix4[], out: Vector3): void {
  out.set(0, 0, 0)
  for (
    let at = points.influenceStarts[index] ?? 0;
    at < (points.influenceStarts[index + 1] ?? 0);
    at++
  ) {
    const m = palette[points.bones[at] ?? 0]?.elements
    if (!m) {
      continue
    }
    const offset = at * 4
    const x = points.coefficients[offset] ?? 0
    const y = points.coefficients[offset + 1] ?? 0
    const z = points.coefficients[offset + 2] ?? 0
    const w = points.coefficients[offset + 3] ?? 0
    out.x += m[0] * x + m[4] * y + m[8] * z + m[12] * w
    out.y += m[1] * x + m[5] * y + m[9] * z + m[13] * w
    out.z += m[2] * x + m[6] * y + m[10] * z + m[14] * w
  }
}

function releaseContact(previous: Float32Array, vertex: number, correction: Vector3): void {
  for (let axis = 0; axis < 3; axis++) {
    const value = correction.getComponent(axis)
    const old = (previous[vertex * 3 + axis] ?? 0) * 0.7
    correction.setComponent(axis, value * old < 0 || Math.abs(value) >= Math.abs(old) ? value : old)
  }
  correction.clampLength(0, CORPSE_CLOTH_LIMIT)
  previous[vertex * 3] = correction.x
  previous[vertex * 3 + 1] = correction.y
  previous[vertex * 3 + 2] = correction.z
}
