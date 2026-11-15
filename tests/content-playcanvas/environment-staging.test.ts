import { expect, test as it } from 'bun:test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process, { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { file, spawn } from 'bun'
import sharp from 'sharp'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

it('scoped compression and staged environment CLI keep all outputs outside public', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'out-west-environment-staging-'))
  const sandbox = join(directory, 'sandbox')
  const source = join(directory, 'source')
  try {
    await mkdir(sandbox)
    await mkdir(source)
    await symlink(join(repository, 'tools'), join(sandbox, 'tools'), 'dir')
    await symlink(join(repository, 'node_modules'), join(sandbox, 'node_modules'), 'dir')
    const fixture = fileURLToPath(new URL('../fixtures/texture-4x4.ktx2', import.meta.url))
    const encoder = join(directory, 'encoder.ts')
    // A toktx 4.4.2 UASTC/KTX2 fixture replaces only the external codec, not file/GLB routing.
    await writeFile(
      encoder,
      `#!/usr/bin/env bun\nawait Bun.write(process.argv.at(-2), Bun.file(${JSON.stringify(fixture)}))\n`,
      { mode: 0o755 },
    )
    const document = new Document()
    const buffer = document.createBuffer()
    const pixels = await sharp(
      Buffer.from(
        Array.from({ length: 16 }, (_, index) => [index % 2 ? 190 : 80, 90, 60, 255]).flat(),
      ),
      { raw: { width: 4, height: 4, channels: 4 } },
    )
      .png()
      .toBuffer()
    const texture = document.createTexture().setImage(pixels).setMimeType('image/png')
    const primitive = document
      .createPrimitive()
      .setAttribute(
        'POSITION',
        document
          .createAccessor()
          .setBuffer(buffer)
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])),
      )
      .setAttribute(
        'TEXCOORD_0',
        document
          .createAccessor()
          .setBuffer(buffer)
          .setType('VEC2')
          .setArray(new Float32Array([0, 0, 1, 0, 0, 1])),
      )
      .setMaterial(document.createMaterial().setBaseColorTexture(texture))
    document
      .createScene()
      .addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)))
    const original = await io.writeBinary(document)
    const input = join(source, 'depot.glb')
    await writeFile(input, original)
    const harness = join(directory, 'scoped.ts')
    await writeFile(
      harness,
      `import {withContentOutput} from ${JSON.stringify(new URL('../../tools/content/content-output.ts', import.meta.url).href)}
import {compressEnvironmentTextures} from ${JSON.stringify(new URL('../../tools/content/environment-textures.ts', import.meta.url).href)}
await Promise.all(JSON.parse(process.argv[2]).map(([root,path])=>withContentOutput(root,()=>compressEnvironmentTextures(path))))
`,
    )
    const run = async (args: string[]) => {
      const child = spawn([process.execPath, ...args], {
        cwd: sandbox,
        env: { ...env, KTX_ENCODER: encoder },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, error: code ? `${stdout}\n${stderr}` : '' }).toEqual({ code: 0, error: '' })
    }
    const roots = [join(directory, 'a'), join(directory, 'b')]
    const jobs = await Promise.all(
      roots.map(async (root) => {
        await mkdir(root)
        const path = join(root, 'model.glb')
        await copyFile(input, path)
        return [root, path] as const
      }),
    )
    await run([harness, JSON.stringify(jobs)])
    await Promise.all(
      jobs.map(async ([root, path]) => {
        const images = await readdir(join(root, 'environments', 'textures'))
        expect(images).toHaveLength(1)
        expect(images[0]?.endsWith('.color.ktx2')).toBe(true)
        const output = await io.read(path)
        expect(output.getRoot().listTextures()[0]?.getMimeType()).toBe('image/ktx2')
        expect(
          output
            .getRoot()
            .listExtensionsRequired()
            .map((extension) => extension.extensionName),
        ).toContain('KHR_texture_basisu')
      }),
    )
    const output = join(directory, 'cli')
    await run([
      'tools/content/environment.ts',
      '--source',
      source,
      '--output',
      output,
      '--only',
      'depot',
    ])
    expect(await file(join(output, 'depot.glb')).exists()).toBe(true)
    expect(await readdir(join(output, 'resources', 'environments', 'textures'))).toHaveLength(1)
    expect((await readdir(sandbox)).sort()).toEqual(['node_modules', 'tools'])
    expect(await readFile(input)).toEqual(Buffer.from(original))
    // The same CLI retains its ordinary publish location when no staging output is supplied.
    await run(['tools/content/environment.ts', '--source', source, '--only', 'depot'])
    expect(
      await file(
        join(sandbox, 'public/experiments/out-west/3d/native-v2/baked/depot.glb'),
      ).exists(),
    ).toBe(true)
    expect(
      await readdir(
        join(sandbox, 'public/experiments/out-west/3d/native-v2/environments/textures'),
      ),
    ).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
