// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isSkinnedMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * Reading a base character in its bind pose (skin space: Y up, facing +Z), before it is posed,
 * measured or dressed: which meshes it has, what bones weigh on a vertex, and where his eyes and
 * chin are. Shared by the edits made there (scene/person.ts, scene/whiskers.ts).
 */
import { type Material, type Object3D, type SkinnedMesh, Vector3 } from 'three'
import { boneKey } from './fit.ts'

export const isSkinned = (o: Object3D): o is SkinnedMesh => (o as SkinnedMesh).isSkinnedMesh
export const matName = (m: SkinnedMesh): string =>
  ((Array.isArray(m.material) ? m.material[0] : m.material) as Material | undefined)?.name ?? ''

/** Every skinned mesh under `model`. */
export function skinnedOf(model: Object3D): SkinnedMesh[] {
  const out: SkinnedMesh[] = []
  model.traverse((o) => {
    if (isSkinned(o)) {
      out.push(o)
    }
  })
  return out
}

/** Landmarks of the bind mesh. */
export interface Land {
  head: Vector3
  eye: number
  chin: number
  spine: Vector3
  chest: Vector3
  hips: number
}

/** Bind-space bone positions by name, from a skeleton's inverse bind matrices. */
export function bindBones(sm: SkinnedMesh): Map<string, Vector3> {
  const out = new Map<string, Vector3>()
  sm.skeleton.bones.forEach((b, i) => {
    const inv = sm.skeleton.boneInverses[i]
    if (inv) {
      out.set(boneKey(b.name), new Vector3().setFromMatrixPosition(inv.clone().invert()))
    }
  })
  return out
}

/** Weight of each named bone on vertex `k` of `sm`. */
export function weightsOf(
  sm: SkinnedMesh,
  k: number,
  names: readonly string[],
): Map<string, number> {
  const si = sm.geometry.getAttribute('skinIndex')
  const sw = sm.geometry.getAttribute('skinWeight')
  const out = new Map<string, number>()
  for (let c = 0; c < 4; c++) {
    const w = sw.getComponent(k, c)
    const n = boneKey(sm.skeleton.bones[si.getComponent(k, c)]?.name ?? '')
    if (w > 0 && names.includes(n)) {
      out.set(n, (out.get(n) ?? 0) + w)
    }
  }
  return out
}

/** His eyes, chin and spine on the bind mesh (null if the base lacks eyes or a face). */
export function landmarks(meshes: readonly SkinnedMesh[]): Land | null {
  const first = meshes[0]
  if (!first) {
    return null
  }
  const bb = bindBones(first)
  const head = bb.get('Head')
  const chest = bb.get('Chest')
  const spine = bb.get('Abdomen') ?? bb.get('Torso')
  const hips = bb.get('Hips')
  if (!(head && chest && spine && hips)) {
    return null
  }
  const v = new Vector3()
  let eyeSum = 0
  let eyeN = 0
  let chin = Number.POSITIVE_INFINITY
  for (const sm of meshes) {
    const name = matName(sm)
    const pos = sm.geometry.getAttribute('position')
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(sm.bindMatrix)
      if (name === 'Eye') {
        eyeSum += v.y
        eyeN++
      } else if (
        name === 'Skin' &&
        v.z > head.z &&
        (weightsOf(sm, k, ['Head']).get('Head') ?? 0) > 0.9
      ) {
        chin = Math.min(chin, v.y)
      }
    }
  }
  if (eyeN === 0 || !Number.isFinite(chin)) {
    return null
  }
  return { head, eye: eyeSum / eyeN, chin, spine, chest, hips: hips.y }
}
