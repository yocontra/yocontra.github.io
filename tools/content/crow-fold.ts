/** Bake and pack the articulated ambient bird before replacing its native asset. */
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, unpartition } from '@gltf-transform/functions'

export async function bakeFoldedCrow(source: string, output: string): Promise<void> {
  const blender = Bun.which('blender')
  if (!blender) {
    throw new Error('Install Blender to bake the ambient crow')
  }
  const directory = dirname(output)
  await mkdir(directory, { recursive: true })
  const staging = await mkdtemp(join(directory, '.crow-fold-'))
  try {
    const raw = join(staging, 'raw.glb')
    const packed = join(staging, 'packed.glb')
    const child = Bun.spawn(
      [
        blender,
        '--background',
        '--factory-startup',
        '--python',
        'tools/content/crow-fold-authoring.py',
        '--',
        raw,
        source,
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    )
    if ((await child.exited) !== 0) {
      throw new Error('Could not bake the articulated crow')
    }
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    const doc = await io.read(raw)
    await doc.transform(dedup(), prune({ keepAttributes: true, keepLeaves: true }), unpartition())
    await io.write(packed, doc)
    await rename(packed, output)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [
    output = '/tmp/out-west-crow-fold/crow.glb',
    source = 'tools/art/environments/crow-articulated-base.glb',
  ] = process.argv.slice(2)
  await bakeFoldedCrow(source, output)
}
