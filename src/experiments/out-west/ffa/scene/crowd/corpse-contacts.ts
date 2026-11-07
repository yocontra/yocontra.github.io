/** Small collision supports come from the actual fitted rigid gear, never a rendered proxy. */
import { type Bone, type BufferGeometry, type Group, Mesh, SkinnedMesh, Vector3 } from 'three'
import type { CorpseLink } from './corpse-rig.ts'

const supports = new WeakMap<BufferGeometry, readonly Vector3[]>()
const directions = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [1, 1, 1],
  [1, 1, -1],
  [1, -1, 1],
  [1, -1, -1],
  [-1, 1, 1],
  [-1, 1, -1],
  [-1, -1, 1],
  [-1, -1, -1],
].map((d) => new Vector3().fromArray(d).normalize())

function points(geometry: BufferGeometry): readonly Vector3[] {
  const cached = supports.get(geometry)
  if (cached) {
    return cached
  }
  const position = geometry.getAttribute('position')
  const extremes = directions.map(() => ({
    distance: Number.NEGATIVE_INFINITY,
    point: new Vector3(),
  }))
  const p = new Vector3()
  for (let vertex = 0; vertex < position.count; vertex++) {
    p.fromBufferAttribute(position, vertex)
    for (const [i, direction] of directions.entries()) {
      const extreme = extremes[i]
      const distance = p.dot(direction)
      if (extreme && distance > extreme.distance) {
        extreme.distance = distance
        extreme.point.copy(p)
      }
    }
  }
  const result = extremes.map((extreme) => extreme.point)
  supports.set(geometry, result)
  return result
}

export function warmRigidContacts(root: Group): void {
  root.traverse((node) => {
    if (node instanceof Mesh && !(node instanceof SkinnedMesh)) {
      points(node.geometry)
    }
  })
}
export function copyRigidContacts(from: BufferGeometry, to: BufferGeometry): void {
  supports.set(to, points(from))
}

export function fitRigidContacts(root: Group, bones: Bone[], links: CorpseLink[]): void {
  const indices = new Map(bones.map((bone, i) => [bone, i]))
  const attached = new Map<number, Vector3[]>()
  root.traverse((gear) => {
    if (!(gear.userData.corpseGear && gear.visible)) {
      return
    }
    let bone = gear.parent
    while (bone && !indices.has(bone as Bone)) {
      bone = bone.parent
    }
    const index = bone ? indices.get(bone as Bone) : undefined
    const link = index === undefined ? undefined : links[index]
    if (index === undefined || !link) {
      return
    }
    const samples = attached.get(index) ?? []
    const inverse = link.rotation.clone().invert()
    gear.traverse((node) => {
      if (!(node instanceof Mesh && node.visible)) {
        return
      }
      for (const p of points(node.geometry)) {
        const local = p
          .clone()
          .applyMatrix4(node.matrixWorld)
          .sub(link.position)
          .applyQuaternion(inverse)
        if (!samples.some((sample) => sample.distanceToSquared(local) < 0.025 ** 2)) {
          samples.push(local)
        }
      }
    })
    attached.set(index, samples)
  })
  for (const [index, samples] of attached) {
    const link = links[index]
    if (link) {
      const selected: Vector3[] = []
      for (const direction of directions) {
        let extreme = samples[0]
        for (const sample of samples) {
          if (extreme && sample.dot(direction) > extreme.dot(direction)) {
            extreme = sample
          }
        }
        if (extreme && !selected.includes(extreme)) {
          selected.push(extreme)
        }
      }
      link.contacts = selected.map((center) => ({ center, radius: 0.012 }))
    }
  }
}
