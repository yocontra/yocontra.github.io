import { expect, test as it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { imageFile } from '../../tools/content/character-atlas.ts'
import { contentOutput, withContentOutput } from '../../tools/content/content-output.ts'

it('concurrent reference bakes stage textures outside public without changing canonical URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'out-west-reference-output-'))
  const original = contentOutput('characters')
  try {
    const paths = await Promise.all(
      [0, 1].map((index) => {
        const target = join(directory, String(index))
        return withContentOutput(target, async () => {
          const width = 16 + index * 16
          const pixels = Buffer.alloc(width * 16 * 4, 120 + index)
          const url = await imageFile(pixels, width, 16, false)
          const file = contentOutput('characters', basename(url))
          const image = await sharp(await readFile(file)).metadata()
          expect(contentOutput('characters')).toBe(join(target, 'characters'))
          expect(url.startsWith('/experiments/out-west/3d/native-v2/characters/')).toBe(true)
          expect(image.width).toBe(width)
          expect(image.height).toBe(16)
          return file
        })
      }),
    )
    expect(paths[0]).not.toBe(paths[1])
    expect(contentOutput('characters')).toBe(original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
