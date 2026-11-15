import { expect, test as it } from 'bun:test'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { file } from 'bun'
import { SCENE_ASSETS } from '../api/src/assets/scene-assets.ts'
import { PAGES_LIMIT, preparePages, verifyScenes } from '../scripts/scene-assets.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'out-west-pages-scenes-'))
  await Promise.all(
    SCENE_ASSETS.flatMap((asset) =>
      ['public', 'dist'].map(async (kind) => {
        const destination = join(directory, kind, asset.path)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(
          join(process.cwd(), 'public', asset.path),
          destination,
          constants.COPYFILE_FICLONE,
        )
      }),
    ),
  )
  await writeFile(join(directory, 'dist', 'historical.glb'), 'immutable historical container')
  return directory
}

it('Pages removes only the five SHA-verified generated scenes and leaves every source intact', async () => {
  const root = await fixture()
  try {
    const before = await verifyScenes(root)
    const result = await preparePages(root)
    expect(result.removed).toHaveLength(5)
    expect(result.after).toBeLessThan(PAGES_LIMIT)
    expect(await verifyScenes(root)).toEqual(before)
    expect(await readFile(join(root, 'dist', 'historical.glb'), 'utf8')).toBe(
      'immutable historical container',
    )
    for (const asset of SCENE_ASSETS) {
      expect(await file(join(root, 'dist', asset.path)).exists()).toBe(false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('a corrupt generated scene aborts before any file removal', async () => {
  const root = await fixture()
  try {
    const scene = SCENE_ASSETS[0]
    if (!scene) {
      throw new Error('Missing scene fixture')
    }
    await writeFile(join(root, 'dist', scene.path), 'corrupt')
    await expect(preparePages(root)).rejects.toThrow('Built scene differs')
    for (const asset of SCENE_ASSETS) {
      expect(await file(join(root, 'dist', asset.path)).exists()).toBe(true)
    }
    expect(await verifyScenes(root)).toHaveLength(5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('a source manifest mismatch aborts before touching the generated artifact', async () => {
  const root = await fixture()
  try {
    const scene = SCENE_ASSETS[0]
    if (!scene) {
      throw new Error('Missing scene fixture')
    }
    await writeFile(join(root, 'public', scene.path), 'unverified source')
    await expect(preparePages(root)).rejects.toThrow('Scene source differs')
    expect(
      await Promise.all(
        SCENE_ASSETS.map(async (asset) => (await stat(join(root, 'dist', asset.path))).size),
      ),
    ).toEqual(SCENE_ASSETS.map((asset) => asset.bytes))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('Pages refuses the exact billion-byte boundary before removal', async () => {
  const root = await fixture()
  try {
    const large = await open(join(root, 'dist', 'over-budget.bin'), 'w')
    await large.truncate(PAGES_LIMIT - (await stat(join(root, 'dist', 'historical.glb'))).size)
    await large.close()
    await expect(preparePages(root)).rejects.toThrow('must be below')
    for (const asset of SCENE_ASSETS) {
      expect((await stat(join(root, 'dist', asset.path))).size).toBe(asset.bytes)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
