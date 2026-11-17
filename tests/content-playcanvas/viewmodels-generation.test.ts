import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { spawn } from 'bun'
import { CATALOG } from '../../src/experiments/out-west/data/catalog.ts'

const project = fileURLToPath(new URL('../../', import.meta.url))
const native = 'public/experiments/out-west/3d/native-v2'
const descriptor = 'src/experiments/out-west/content/viewmodels.ts'
const fits = CATALOG.filter((item) => item.slot === 'outfit').flatMap((item) => [
  item.id,
  `${item.id}.pair`,
])
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// Two complete builds and two fits before a malformed input: 34 successful extractions.
const rebuildBudget = 180_000

function hashes(directory: string): Promise<string[]> {
  return Promise.all(fits.map(async (id) => hash(await readFile(join(directory, `${id}.glb`)))))
}

async function textureHashes(directory: string): Promise<string[]> {
  const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b))
  const values: string[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < names.length) {
        const index = next++
        const name = names[index]
        if (name) {
          values[index] = `${name}:${hash(await readFile(join(directory, name)))}`
        }
      }
    }),
  )
  return values
}

async function seedTextureCache(directory: string): Promise<void> {
  const needed = new Set<string>()
  for (const id of fits) {
    const bytes = await readFile(join(project, native, 'viewmodels', `${id}.glb`))
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as {
      extras?: { firstPersonArms?: { presentation?: { textures: { path: string }[] } } }
    }
    for (const texture of json.extras?.firstPersonArms?.presentation?.textures ?? []) {
      needed.add(texture.path)
    }
  }
  await mkdir(directory, { recursive: true })
  await Promise.all(
    [...needed].map((path) =>
      copyFile(join(project, path), join(directory, basename(path)), constants.COPYFILE_FICLONE),
    ),
  )
}

async function disposeFixture(root: string, realTextures: string): Promise<string[]> {
  try {
    return await textureHashes(realTextures)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fitAt(index: number): string {
  const id = fits[index]
  if (!id) {
    throw new Error(`Missing fit at ${index}`)
  }
  return id
}

async function runFixture(root: string, deadline: number, phase: string) {
  const child = spawn([process.execPath, 'tools/content/viewmodels.ts'], {
    cwd: root,
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stop = () => {
    try {
      // The formatter inherits this owned process group and its output pipes.
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
  let timedOut = false
  const watchdog = setTimeout(
    () => {
      timedOut = true
      stop()
    },
    Math.max(1, deadline - performance.now()),
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timedOut) {
      throw new Error(
        `Viewmodel CLI exhausted the bounded rebuild budget during ${phase}\nstdout tail:\n${stdout.slice(-4096)}\nstderr tail:\n${stderr.slice(-4096)}`,
      )
    }
    return { code, output: `${phase}\n${stdout}${stderr}` }
  } finally {
    clearTimeout(watchdog)
    stop()
    await child.exited
  }
}

it(
  'the CLI rebuilds all missing fitted arms deterministically and preserves outputs on a late invalid input',
  async () => {
    const deadline = performance.now() + rebuildBudget - 5000
    const realTextures = join(project, native, 'characters')
    const textureInputs = await textureHashes(realTextures)
    const root = await mkdtemp(join(tmpdir(), 'out-west-viewmodels-'))

    try {
      await mkdir(join(root, 'tools/art'), { recursive: true })
      await mkdir(join(root, 'src/experiments/out-west/content'), { recursive: true })
      await mkdir(join(root, native, 'equipment'), { recursive: true })
      await cp(join(project, 'tools/content'), join(root, 'tools/content'), { recursive: true })
      const fixtureTextures = join(root, native, 'characters')
      await seedTextureCache(fixtureTextures)
      // Guard ownership before testing a new output path; a directory-link regression must not write to the project.
      expect((await lstat(fixtureTextures)).isSymbolicLink()).toBe(false)
      const uncachedOutput = join(fixtureTextures, 'fixture-owned-new-map.ktx2')
      const textureMarker = Buffer.from('new output stays in the isolated texture directory')
      await writeFile(uncachedOutput, textureMarker, { flag: 'wx' })
      await Promise.all([
        symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir'),
        symlink(join(project, 'tools/art/characters'), join(root, 'tools/art/characters'), 'dir'),
        symlink(
          join(project, 'src/experiments/out-west/data'),
          join(root, 'src/experiments/out-west/data'),
          'dir',
        ),
        ...['biome.json', '.gitignore', 'bun.lock', 'patches'].map((path) =>
          symlink(join(project, path), join(root, path)),
        ),
        ...fits.map((id) =>
          symlink(
            join(project, native, 'equipment', `${id}.glb`),
            join(root, native, 'equipment', `${id}.glb`),
          ),
        ),
      ])
      const inputs = await hashes(join(project, native, 'equipment'))
      const helperHash = hash(await readFile(join(project, 'tools/content/first-person-arms.ts')))
      const first = await runFixture(root, deadline, 'initial all16 build')
      expect(first.code, first.output).toBe(0)
      expect(fits).toHaveLength(16)
      const bytes = await Promise.all(
        fits.map((id) => readFile(join(root, native, 'viewmodels', `${id}.glb`))),
      )
      const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      const models = await Promise.all(bytes.map((data) => io.readBinary(data)))
      for (const [index, data] of bytes.entries()) {
        const id = fits[index]
        const arms = models[index]
        if (!(id && arms)) {
          throw new Error('Missing fit')
        }
        const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString())
        expect(json.animations ?? []).toHaveLength(0)
        expect(json.images ?? []).toHaveLength(0)
        expect(json.extras.firstPersonArms).toMatchObject({
          fit: id,
          animationMode: 'geometry-only',
          nativeSHA256: inputs[index],
          helperSHA256: helperHash,
        })
        let faces = 0
        for (const node of arms.getRoot().listNodes()) {
          for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
            expect(
              node
                .getSkin()
                ?.listJoints()
                .some((joint) => joint.getName() === 'WristR'),
            ).toBe(true)
            const positions = primitive.getAttribute('POSITION')
            const indices = primitive.getIndices()
            if (!(positions && indices)) {
              throw new Error(`Missing fitted geometry for ${id}`)
            }
            expect(positions.getCount()).toBeGreaterThan(0)
            expect(indices.getCount() % 3).toBe(0)
            for (const semantic of ['NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']) {
              expect(primitive.getAttribute(semantic)?.getCount()).toBe(positions.getCount())
            }
            faces += indices.getCount() / 3
          }
        }
        expect(faces).toBeGreaterThan(0)
        expect(json.extras.firstPersonArms.sourceFaces).toBe(faces)
        expect(json.extras.firstPersonArms.retainedFaces).toBe(faces)
      }
      const generated = await import(join(root, descriptor))
      expect(Object.keys(generated.VIEWMODELS)).toEqual(fits)
      for (const [index, data] of bytes.entries()) {
        const id = fits[index]
        const digest = hash(data)
        expect(generated.VIEWMODELS[id ?? '']).toEqual({
          url: `/experiments/out-west/3d/native-v2/viewmodels/${id}.glb?v=${digest.slice(0, 16)}`,
          hash: digest,
          bytes: data.length,
        })
      }
      const before = await readFile(join(root, descriptor))
      const second = await runFixture(root, deadline, 'deterministic all16 rebuild')
      expect(second.code, second.output).toBe(0)
      expect(await readFile(join(root, descriptor))).toEqual(before)
      expect(await hashes(join(root, native, 'viewmodels'))).toEqual(bytes.map(hash))
      const last = fitAt(fits.length - 1)
      await unlink(join(root, native, 'equipment', `${last}.glb`))
      const marker = Buffer.from('previous asset must survive a later invalid fit')
      const output = join(root, native, 'viewmodels', `${fits[0]}.glb`)
      const secondOutput = join(root, native, 'viewmodels', `${fits[1]}.glb`)
      await writeFile(output, marker)
      await writeFile(secondOutput, marker)
      const failed = await runFixture(root, deadline, 'missing last world input')
      expect(failed.code).not.toBe(0)
      expect(failed.output).toContain(`${last}.glb`)
      expect(failed.output).not.toContain('Staged viewmodel ')
      expect(await readFile(output)).toEqual(marker)
      expect(await readFile(secondOutput)).toEqual(marker)
      expect(await readFile(join(root, descriptor))).toEqual(before)
      await symlink(
        join(project, native, 'equipment', `${last}.glb`),
        join(root, native, 'equipment', `${last}.glb`),
      )
      const third = fitAt(2)
      const malformedInput = join(root, native, 'equipment', `${third}.glb`)
      await unlink(malformedInput)
      await writeFile(malformedInput, Buffer.from('malformed present native GLB'), { flag: 'wx' })
      expect((await lstat(malformedInput)).isSymbolicLink()).toBe(false)
      const malformed = await runFixture(
        root,
        deadline,
        'malformed third world input after two staged fits',
      )
      expect(malformed.code).not.toBe(0)
      expect(Array.from(malformed.output.match(/^Staged viewmodel .+$/gmu) ?? [])).toEqual(
        fits.slice(0, 2).map((id) => `Staged viewmodel ${id}`),
      )
      expect(await readFile(output)).toEqual(marker)
      expect(await readFile(secondOutput)).toEqual(marker)
      expect(await readFile(join(root, descriptor))).toEqual(before)
      expect(await hashes(join(project, native, 'equipment'))).toEqual(inputs)
      expect(await readFile(uncachedOutput)).toEqual(textureMarker)
    } finally {
      expect(await disposeFixture(root, realTextures)).toEqual(textureInputs)
    }
  },
  rebuildBudget,
)
