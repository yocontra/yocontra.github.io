/** Refuse stale portable pose artifacts after their canonical source changes. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Document } from '@gltf-transform/core'

export async function validateAuthoringInputs(doc: Document): Promise<void> {
  const inputs = doc.getRoot().getExtras().sourceInputs as
    | { path: string; sha256: string }[]
    | undefined
  if (!inputs?.length) {
    throw new Error('Authored pose requires canonical source provenance')
  }
  await Promise.all(
    inputs.map(async (input) => {
      const bytes = await Bun.file(resolve(input.path)).arrayBuffer()
      const actual = createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
      if (actual !== input.sha256) {
        throw new Error(`Regenerate authored pose after changing ${input.path}`)
      }
    }),
  )
}
