import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { VIEWMODELS } from '../../src/experiments/out-west/content/viewmodels.ts'
import { CATALOG } from '../../src/experiments/out-west/data/catalog.ts'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

it('every committed arms fit matches its descriptor and current canonical art inputs', async () => {
  const fits = CATALOG.filter((item) => item.slot === 'outfit').flatMap((item) => [
    item.id,
    `${item.id}.pair`,
  ])
  expect(Object.keys(VIEWMODELS)).toEqual(fits)
  const helper = hash(await readFile('tools/content/first-person-arms.ts'))
  for (const id of fits) {
    const asset = VIEWMODELS[id]
    if (!asset) {
      throw new Error(`Missing committed arms for ${id}`)
    }
    const path = `/experiments/out-west/3d/native-v2/viewmodels/${id}.glb`
    const bytes = await readFile(`public${path}`)
    const digest = hash(bytes)
    expect(asset).toEqual({
      url: `${path}?v=${digest.slice(0, 16)}`,
      hash: digest,
      bytes: bytes.length,
    })
    const doc = await io.readBinary(bytes)
    const provenance = doc.getRoot().getExtras().firstPersonArms as {
      sourceInputs?: { path: string; sha256: string }[]
    }
    const nativePath = `public/experiments/out-west/3d/native-v2/equipment/${id}.glb`
    const nativeHash = hash(await readFile(nativePath))
    expect(provenance).toMatchObject({
      fit: id,
      animationMode: 'geometry-only',
      nativePath,
      nativeSHA256: nativeHash,
      helperSHA256: helper,
    })
    expect(provenance.sourceInputs).toContainEqual({ path: nativePath, sha256: nativeHash })
    // Reuse the authoring validator for every recorded cloth, rig and helper dependency.
    doc.getRoot().setExtras({ sourceInputs: provenance.sourceInputs ?? [] })
    await validateAuthoringInputs(doc)
    expect(doc.getRoot().listAnimations()).toHaveLength(0)
    expect(doc.getRoot().listTextures()).toHaveLength(0)
  }
})
