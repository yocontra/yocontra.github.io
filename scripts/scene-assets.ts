/** Keep Pages below its byte budget without changing source public files or historical assets. */
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'bun'
import { SCENE_ASSETS, SCENE_BUCKET, sceneKey } from '../api/src/assets/scene-assets.ts'

export const PAGES_LIMIT = 1_000_000_000
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function verifyScenes(root = process.cwd()) {
  return await Promise.all(
    SCENE_ASSETS.map(async (asset) => {
      const file = join(root, 'public', asset.path)
      const bytes = await readFile(file)
      if (
        bytes.length !== asset.bytes ||
        digest(bytes) !== asset.hash ||
        !asset.url.endsWith(`?v=${asset.hash.slice(0, 16)}`)
      ) {
        throw new Error(`Scene source differs from manifest: ${asset.path}`)
      }
      return { ...asset, file, key: sceneKey(asset.path, asset.hash.slice(0, 16)) }
    }),
  )
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const lists = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in the Pages artifact: ${path}`)
      }
      return entry.isDirectory() ? await files(path) : [path]
    }),
  )
  return lists.flat()
}

export async function preparePages(root = process.cwd()) {
  const scenes = await verifyScenes(root)
  const dist = resolve(root, 'dist')
  const inventory = await files(dist)
  const before = (await Promise.all(inventory.map(async (path) => (await stat(path)).size))).reduce(
    (sum, n) => sum + n,
    0,
  )
  // Validate every candidate before removing anything; source public is never a mutation target.
  const removed = await Promise.all(
    scenes.map(async (scene) => {
      const path = join(dist, scene.path)
      const bytes = await readFile(path)
      if (bytes.length !== scene.bytes || digest(bytes) !== scene.hash) {
        throw new Error(`Built scene differs from manifest: ${scene.path}`)
      }
      return { path, bytes: bytes.length, sha256: scene.hash }
    }),
  )
  const after = before - removed.reduce((sum, entry) => sum + entry.bytes, 0)
  if (after >= PAGES_LIMIT) {
    throw new Error(`Pages artifact would still be ${after} bytes; must be below ${PAGES_LIMIT}.`)
  }
  await Promise.all(removed.map(async ({ path }) => await unlink(path)))
  await verifyScenes(root)
  return {
    before,
    removed: removed.map(({ path, ...entry }) => ({ path: path.slice(dist.length), ...entry })),
    after,
    limit: PAGES_LIMIT,
  }
}

async function wrangler(args: string[]) {
  const child = spawn(['node', 'node_modules/wrangler/bin/wrangler.js', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })
  if ((await child.exited) !== 0) {
    throw new Error(`Wrangler failed: ${args.slice(0, 3).join(' ')}`)
  }
}

/** Only called explicitly by the reusable deployment job, after the build/size gate succeeds. */
export async function uploadScenes() {
  const scenes = await verifyScenes()
  const directory = await mkdtemp(join(tmpdir(), 'out-west-scene-readback-'))
  try {
    for (const scene of scenes) {
      const target = `${SCENE_BUCKET}/${scene.key}`
      // Content-addressed keys are retained indefinitely; there is no delete or lifecycle command.
      await wrangler([
        'r2',
        'object',
        'put',
        target,
        '--remote',
        '--config',
        'api/wrangler.jsonc',
        '--file',
        scene.file,
        '--content-type',
        'model/gltf-binary',
        '--cache-control',
        'public, max-age=31536000, immutable',
      ])
      const output = join(directory, `${scene.hash}.glb`)
      await wrangler([
        'r2',
        'object',
        'get',
        target,
        '--remote',
        '--config',
        'api/wrangler.jsonc',
        '--file',
        output,
      ])
      const bytes = await readFile(output)
      if (bytes.length !== scene.bytes || digest(bytes) !== scene.hash) {
        throw new Error(`R2 readback differs from source: ${target}`)
      }
      console.log(`Verified R2 scene: ${target} (${scene.bytes} bytes, SHA-256 ${scene.hash})`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === 'prepare-pages') {
    console.log(JSON.stringify(await preparePages(), null, 2))
  } else if (command === 'upload') {
    await uploadScenes()
  } else {
    throw new Error('Usage: bun scripts/scene-assets.ts prepare-pages|upload')
  }
}
