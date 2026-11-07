/** Index-only simplification of the real skin, keeping its material, cloth and binding seams. */
import { Bone, type BufferGeometry, type SkinnedMesh } from 'three'
import { boneKey } from '../../scene/fit.ts'
import type { SimplifyJob } from '../../scene/lod.ts'
import { CORPSE_BONES } from './crowd/corpse-rig.ts'

const regionIndices = new Map<string, number>(CORPSE_BONES.map((key, index) => [key, index]))

function regions(skin: SkinnedMesh | undefined): number[] {
  return (
    skin?.skeleton.bones.map((bone) => {
      let current: typeof bone | null = bone
      while (current) {
        const region = regionIndices.get(boneKey(current.name))
        if (region !== undefined) {
          return region
        }
        current = current.parent instanceof Bone ? current.parent : null
      }
      return 0
    }) ?? []
  )
}

function semanticGroups(geometry: BufferGeometry): Uint32Array {
  const count = geometry.getAttribute('position').count
  const cloth = new Uint8Array(count)
  const ranges = geometry.userData.clothRanges as { start: number; count: number }[] | undefined
  for (const range of ranges ?? []) {
    cloth.fill(1, range.start, range.start + range.count)
  }
  const attributes = ['skinIndex', 'skinWeight', 'styMat', 'styLum', 'paletteSlot'].flatMap(
    (name) => {
      const attribute = geometry.getAttribute(name)
      return attribute ? [attribute] : []
    },
  )
  const ids = new Map<string, number>()
  const seams = new Uint32Array(count)
  for (let vertex = 0; vertex < count; vertex++) {
    let key = `${cloth[vertex]}`
    for (const attribute of attributes) {
      for (let component = 0; component < attribute.itemSize; component++) {
        key += `/${Math.round(attribute.getComponent(vertex, component) * 100_000)}`
      }
    }
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    seams[vertex] = id
  }
  return seams
}

/** Skin-region weight fields constrain deformation error as well as neutral silhouette error. */
export function corpseLodJob(geometry: BufferGeometry, skin?: SkinnedMesh): SimplifyJob {
  const position = geometry.getAttribute('position')
  const color = geometry.getAttribute('color')
  const uv = geometry.getAttribute('uv')
  const normal = geometry.getAttribute('normal')
  const skinIndex = geometry.getAttribute('skinIndex')
  const skinWeight = geometry.getAttribute('skinWeight')
  const mapping = regions(skin)
  const weights = [0.6, 0.6, 0.6, 1.5, 1.5, 0.6, 0.6, 0.6]
  if (skinIndex && skinWeight) {
    weights.push(...CORPSE_BONES.map(() => 2))
  }
  const stride = weights.length
  const positions = new Float32Array(position.count * 3)
  const colors = new Float32Array(position.count * stride)
  for (let vertex = 0; vertex < position.count; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      positions[vertex * 3 + axis] = position.getComponent(vertex, axis)
      colors[vertex * stride + axis] = color?.getComponent(vertex, axis) ?? 1
      colors[vertex * stride + axis + 5] = normal?.getComponent(vertex, axis) ?? 0
    }
    colors[vertex * stride + 3] = uv?.getX(vertex) ?? 0
    colors[vertex * stride + 4] = uv?.getY(vertex) ?? 0
    if (skinIndex && skinWeight) {
      for (let influence = 0; influence < 4; influence++) {
        const region = mapping[skinIndex.getComponent(vertex, influence)] ?? 0
        const at = vertex * stride + 8 + region
        colors[at] = (colors[at] ?? 0) + skinWeight.getComponent(vertex, influence)
      }
    }
  }
  const index = Uint32Array.from(
    geometry.index?.array ?? Array.from({ length: position.count }, (_, vertex) => vertex),
  )
  return {
    index,
    positions,
    colors,
    stride,
    weights,
    seams: semanticGroups(geometry),
    targetTris: index.length / 3,
    maxError: 0,
  }
}
