import { expect, test as it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { compressedCharacterTexture } from '../../tools/content/character-textures.ts'
import { withContentOutput } from '../../tools/content/content-output.ts'

it('stages the exact keyed KTX2 without an encoder, but changed source still requires encoding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'out-west-cache-'))
  const environment = process.env
  const oldPath = environment.PATH
  const oldEncoder = environment.KTX_ENCODER
  try {
    environment.PATH = ''
    Reflect.deleteProperty(environment, 'KTX_ENCODER')
    const source =
      '/experiments/out-west/3d/native-v2/characters/6c5151f22e28e18b580ed90e.color.webp'
    const expected =
      '/experiments/out-west/3d/native-v2/characters/0ce0c1946bb1b320db36e2df.color.ktx2'
    const bytes = await readFile(`public${source}`)
    const cached = await readFile(`public${expected}`)
    const url = await withContentOutput(directory, () => compressedCharacterTexture(bytes, true))
    expect(url).toBe(expected)
    const staged = await readFile(join(directory, 'characters', basename(url)))
    expect(staged).toEqual(cached)
    expect(staged.subarray(0, 12)).toEqual(
      Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    const last = bytes.length - 1
    bytes[last] = (bytes[last] ?? 0) ^ 1
    await expect(
      withContentOutput(directory, () => compressedCharacterTexture(bytes, true)),
    ).rejects.toThrow('Set KTX_ENCODER')
  } finally {
    if (oldPath === undefined) {
      Reflect.deleteProperty(environment, 'PATH')
    } else {
      environment.PATH = oldPath
    }
    if (oldEncoder === undefined) {
      Reflect.deleteProperty(environment, 'KTX_ENCODER')
    } else {
      environment.KTX_ENCODER = oldEncoder
    }
    await rm(directory, { recursive: true, force: true })
  }
})
