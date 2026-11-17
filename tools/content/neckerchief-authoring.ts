/** Author the band against the accepted skin surface, never an animation pose. */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { repairHeadNape } from './head-nape.ts'

const io = new NodeIO()
const directory = resolve('tools/art/characters')
const chosen = new Set(process.argv.slice(2))
await mkdir(resolve('.out-west-qa/collar'), { recursive: true })
const temporary = await mkdtemp(resolve('.out-west-qa/collar/donor-'))
try {
  const donors: Record<string, { positions: number[][]; source: string }> = {}
  for (const file of await readdir(directory)) {
    const id = file.replace(/\.gltf$/u, '')
    if (!file.endsWith('.gltf') || (chosen.size > 0 && !chosen.has(id))) {
      continue
    }
    const original = await io.read(resolve(directory, file))
    const hasBand = original
      .getRoot()
      .listNodes()
      .some(
        (candidateNode) =>
          candidateNode.getSkin() &&
          (
            (candidateNode.getExtras().pieceRanges ?? []) as {
              swatch?: string
              name?: string
              slot?: string
              count: number
            }[]
          ).some(
            (range) => range.swatch === 'linen' && !range.name && !range.slot && range.count === 72,
          ),
      )
    if (!hasBand) {
      continue
    }
    const donorId = id.startsWith('extra.') ? 'player' : id
    const doc = donorId === id ? original : await io.read(resolve(directory, `${donorId}.gltf`))
    await repairHeadNape(doc)
    const node = doc
      .getRoot()
      .listNodes()
      .find((n) => n.getSkin() && n.getExtras().pieceRanges)
    const position = node?.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')
    if (position) {
      donors[id] = {
        positions: Array.from({ length: position.getCount() }, (_, i) =>
          position.getElement(i, []),
        ),
        source: donorId,
      }
    }
  }
  const input = resolve(temporary, 'donors.json')
  await writeFile(input, JSON.stringify(donors))
  const child = Bun.spawn(
    [
      process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender',
      '--background',
      '--factory-startup',
      '--threads',
      '2',
      '--python-exit-code',
      '1',
      '--python',
      'tools/content/neckerchief-authoring.py',
      '--',
      input,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (await child.exited) {
    throw new Error('Blender neckerchief authoring failed')
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
