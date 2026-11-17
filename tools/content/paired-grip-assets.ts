/** Native asset variants couple paired hand poses, rigid seats and prop animation. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, unpartition } from '@gltf-transform/functions'
import { validateAuthoringInputs } from './authoring-inputs.ts'
import { appendClips } from './character-clips.ts'
import { contentOutput } from './content-output.ts'
import { resampleNative } from './native-resample.ts'
import { applyPairedGripSeats } from './paired-grip-seats.ts'

export async function bakePairedGripAssets(): Promise<void> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const bodyPath = 'tools/art/characters/paired-grips/body.glb'
  const mechanismsPath = 'tools/art/characters/paired-grips/mechanisms.glb'
  const body = await io.read(bodyPath)
  const actions = await io.read(mechanismsPath)
  await validateAuthoringInputs(body)
  await validateAuthoringInputs(actions)
  await actions.transform(resampleNative())
  for (const id of ['gun.hardins-pair', 'outlaw-5', 'outlaw-16']) {
    const category = id.startsWith('gun.') ? 'equipment' : 'baked'
    const source = `public/experiments/out-west/3d/native-v2/${category}/${id}.glb`
    const doc = await io.read(source)
    if (doc.getRoot().listTextures().length > 0) {
      throw new Error(`Compress native character textures before composing ${id}`)
    }
    applyPairedGripSeats(doc, body)
    appendClips(doc, actions)
    const sourceInputs = await Promise.all(
      [
        source,
        bodyPath,
        mechanismsPath,
        'bun.lock',
        'tools/content/character-clips.ts',
        'tools/content/paired-grip-assets.ts',
        'tools/content/paired-grip-seats.ts',
        'tools/content/native-resample.ts',
      ].map(async (path) => ({
        path,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      })),
    )
    doc.getRoot().setExtras({ ...doc.getRoot().getExtras(), sourceInputs })
    await doc.transform(dedup(), prune({ keepLeaves: true, keepAttributes: true }), unpartition())
    await io.write(contentOutput(category, `${id}.pair.glb`), doc)
  }
}
if (import.meta.main) {
  await bakePairedGripAssets()
}
