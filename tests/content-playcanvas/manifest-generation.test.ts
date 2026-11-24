import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn } from 'bun'
import sharp from 'sharp'
import { AMBIENT_ASSETS } from '../../src/experiments/out-west/content/ambient.ts'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import fittedSleeves from '../../src/experiments/out-west/content/fitted-sleeves.json' with {
  type: 'json',
}
import {
  ASSETS,
  DYNAMIC_ASSETS,
  ENVIRONMENT,
} from '../../src/experiments/out-west/content/manifest.ts'
import type { ContentAsset } from '../../src/experiments/out-west/content/types.ts'
import { hangTimeout } from '../timeout.ts'

const project = fileURLToPath(new URL('../../', import.meta.url))
const content = 'src/experiments/out-west/content'
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const regenerated = new Set([
  'public/experiments/out-west/3d/native-v2/baked/moves.glb',
  'public/experiments/out-west/3d/native-v2/baked/outlaw-5.pair.glb',
  'public/experiments/out-west/3d/native-v2/baked/outlaw-16.pair.glb',
  'public/experiments/out-west/3d/native-v2/equipment/gun.hardins-pair.pair.glb',
])
const CONTENT_VERSION = /^export const CONTENT_VERSION = ['"](?<value>[a-f0-9]+)['"]/mu

function version(source: string): string {
  const value = CONTENT_VERSION.exec(source)?.groups?.value
  if (!value) {
    throw new Error('Generated manifest has no content version')
  }
  return value
}

it(
  'ambient byte changes refresh descriptors and content version without changing other inputs',
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'out-west-manifest-'))
    const assets = [
      ...Object.values(ASSETS),
      ...Object.values(fittedSleeves),
      ...Object.values(DYNAMIC_ASSETS),
      ...Object.values(AMBIENT_ASSETS),
      ...Object.values(EQUIPMENT).flatMap<ContentAsset>((asset) =>
        'pair' in asset ? [asset, asset.pair] : [asset],
      ),
      ENVIRONMENT,
    ]
    const inputs = [
      'biome.json',
      '.gitignore',
      'bun.lock',
      'tools/art/characters',
      'tools/content',
      'tools/art/environments/frontier.json',
      ...['collision', 'depot', 'mission', 'bank'].map((id) => `${content}/${id}.json`),
      ...assets.map((asset) => `public${asset.url.split('?')[0]}`),
    ]
    const originalHashes = new Map(
      await Promise.all(
        [...regenerated].map(
          async (path) => [path, sha256(await readFile(join(project, path)))] as const,
        ),
      ),
    )
    const generate = async () => {
      const child = spawn([process.execPath, join(project, 'tools/content/manifest.ts')], {
        cwd: fixture,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) {
        throw new Error(`Manifest fixture failed: ${stdout}\n${stderr}`)
      }
      return {
        manifest: await readFile(join(fixture, content, 'manifest.ts'), 'utf8'),
        ambient: await readFile(join(fixture, content, 'ambient.ts'), 'utf8'),
      }
    }
    try {
      await symlink(join(project, 'node_modules'), join(fixture, 'node_modules'), 'dir')
      await Promise.all(
        [...new Set(inputs)].map(async (path) => {
          const destination = join(fixture, path)
          await mkdir(dirname(destination), { recursive: true })
          if (regenerated.has(path)) {
            await copyFile(join(project, path), destination)
          } else {
            await symlink(join(project, path), destination)
          }
        }),
      )
      await writeFile(
        join(fixture, content, 'ambient.ts'),
        await readFile(join(project, content, 'ambient.ts')),
      )
      const before = await generate()
      const replacement = await sharp({
        create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer()
      const pathname = AMBIENT_ASSETS.dust.url.split('?')[0]
      if (!pathname) {
        throw new Error('Ambient texture needs a published path')
      }
      const target = join(fixture, `public${pathname}`)
      expect(sha256(replacement)).not.toBe(sha256(await readFile(target)))
      await unlink(target)
      await writeFile(target, replacement)
      const after = await generate()
      const hash = sha256(replacement)
      expect(version(after.manifest)).not.toBe(version(before.manifest))
      expect(after.ambient).toContain(hash)
      expect(after.ambient).toContain(`${pathname}?v=${hash.slice(0, 16)}`)
      expect(await generate()).toEqual(after)
      const checkoutHashes = new Map(
        await Promise.all(
          [...regenerated].map(
            async (path) => [path, sha256(await readFile(join(project, path)))] as const,
          ),
        ),
      )
      expect(checkoutHashes).toEqual(originalHashes)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  },
  hangTimeout(180_000),
)
