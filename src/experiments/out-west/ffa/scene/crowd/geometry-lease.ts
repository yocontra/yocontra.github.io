/** Keep immutable dressed buffers alive across the actor, its LOD wrappers and physical corpses. */
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from 'three'

interface Family {
  references: number
  geometries: Set<BufferGeometry>
}
interface Lease {
  references: number
  family: Family
}
const leases = new WeakMap<BufferGeometry, Lease>()
const families = new WeakMap<BufferAttribute | InterleavedBufferAttribute, Family>()
export function ownGeometry(geometry: BufferGeometry): void {
  if (leases.has(geometry)) {
    return
  }
  const position = geometry.getAttribute('position')
  let family = families.get(position)
  if (!family) {
    family = { references: 0, geometries: new Set() }
    families.set(position, family)
  }
  family.references++
  family.geometries.add(geometry)
  leases.set(geometry, { references: 1, family })
}
export function retainGeometry(geometry: BufferGeometry): BufferGeometry {
  const lease = leases.get(geometry)
  if (!lease) {
    throw new Error('Cannot retain geometry without its source owner')
  }
  lease.references++
  lease.family.references++
  return geometry
}
export function releaseGeometry(geometry: BufferGeometry): void {
  const lease = leases.get(geometry)
  if (!lease) {
    throw new Error('Geometry ownership was already released')
  }
  lease.references--
  lease.family.references--
  if (lease.references === 0) {
    leases.delete(geometry)
  }
  if (lease.family.references === 0) {
    for (const sibling of lease.family.geometries) {
      sibling.dispose()
    }
    lease.family.geometries.clear()
    families.delete(geometry.getAttribute('position'))
  }
}
export const geometryReferences = (geometry: BufferGeometry): number =>
  leases.get(geometry)?.references ?? 0
