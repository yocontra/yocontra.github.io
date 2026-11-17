/** Prepare the explicit family plan; Blender and public bakes never run here. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import family from './head-throat-family.json' with { type: 'json' }
import { constrainedThroatRecipe, planHeadThroat, THROAT_GEOMETRY_IDS } from './head-throat-plan.ts'

const directory = resolve('.out-west-qa/head-throat/family')
await mkdir(directory, { recursive: true })
const io = new NodeIO()
const plans: (ReturnType<typeof planHeadThroat> & {
  id: string
  sourceInputs: { path: string; sha256: string }[]
})[] = []
for (const id of THROAT_GEOMETRY_IDS) {
  const canonical = `tools/art/characters/${id}.gltf`
  const bytes = await readFile(canonical)
  const raw = JSON.parse(bytes.toString()) as { buffers: { uri: string }[] }
  const paths = [canonical, ...raw.buffers.map((b) => `tools/art/characters/${b.uri}`)]
  const sourceInputs = await Promise.all(
    [...new Set(paths)].map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    })),
  )
  const fixed = constrainedThroatRecipe(id)
  if (fixed && JSON.stringify(sourceInputs) !== JSON.stringify(fixed.sourcePins)) {
    throw new Error(`Constrained anterior source bytes changed: ${id}`)
  }
  plans.push({ id, ...planHeadThroat(await io.read(canonical), id), sourceInputs })
}
await writeFile(
  resolve(directory, 'plans.json'),
  `${JSON.stringify(
    {
      family,
      inventorySHA256: createHash('sha256')
        .update(await readFile('tools/content/head-throat-family.json'))
        .digest('hex'),
      plans,
    },
    null,
    2,
  )}\n`,
)
console.log(`Prepared ${plans.length} shape-guarded family plans; no native author or bake ran.`)
