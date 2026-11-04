import { BufferAttribute, type BufferGeometry } from 'three'

/** Drop an attribute's CPU array once it is uploaded (three's documented pattern). */
function release(this: { array: unknown }): void {
  this.array = null
}

/**
 * Production: free a static geometry's CPU copies once they are on the GPU (dev keeps them for the
 * float audit). Its bounding sphere must already be computed.
 */
export function releaseAfterUpload(geo: BufferGeometry): void {
  if (import.meta.env.DEV) {
    return
  }
  for (const attr of Object.values(geo.attributes)) {
    if (attr instanceof BufferAttribute) {
      attr.onUpload(release)
    }
  }
  geo.index?.onUpload(release)
}
