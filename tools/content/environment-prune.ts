import type { Document } from '@gltf-transform/core'
import { prune } from '@gltf-transform/functions'

/** Remove unreferenced native resources without changing scene data or authoring precision. */
export function pruneNativeEnvironment(document: Document): Promise<Document> {
  return document.transform(
    prune({
      keepLeaves: true,
      keepAttributes: true,
      keepIndices: true,
      keepSolidTextures: true,
    }),
  )
}
