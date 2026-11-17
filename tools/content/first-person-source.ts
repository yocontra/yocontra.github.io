/** A complete inner shirt is an offline presentation source, never the occluded world mesh. */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import { bakeCharacter } from './character-materials.ts'
import { compressCharacterAssets } from './character-textures.ts'
import { withContentOutput } from './content-output.ts'
import { FIRST_PERSON_SLEEVE_DONORS } from './first-person-sleeves.ts'

export interface PresentationTexture {
  path: string
  bytes: Uint8Array
  sha256: string
}
const rasterInput = /\.(?:png|webp|json)$/u
const textureUrl = /"(?<url>[^"\s]+\.ktx2)"/gu
const prefix = '/experiments/out-west/3d/native-v2/'
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
async function moduleInputs(path: string, paths: Set<string>): Promise<void> {
  if (paths.has(path)) {
    return
  }
  paths.add(path)
  if (!path.endsWith('.ts')) {
    return
  }
  const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(await readFile(path))
  await Promise.all(
    imports
      .filter((entry) => entry.path.startsWith('.'))
      .map((entry) => moduleInputs(resolve(dirname(path), entry.path), paths)),
  )
}
async function inputs(id: string): Promise<string[]> {
  const paths = new Set<string>()
  await moduleInputs(resolve(import.meta.path), paths)
  const sourcePath = resolve('tools/art/characters', `${id}.gltf`)
  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as {
    buffers: { uri: string }[]
    images?: { uri?: string }[]
  }
  paths.add(sourcePath)
  for (const file of [...source.buffers, ...(source.images ?? [])]) {
    if (file.uri && !file.uri.startsWith('data:')) {
      paths.add(resolve(dirname(sourcePath), file.uri))
    }
  }
  for (const directory of ['textures', 'head-nape']) {
    for (const file of await readdir(resolve('tools/art/characters', directory))) {
      if (rasterInput.test(file)) {
        paths.add(resolve('tools/art/characters', directory, file))
      }
    }
  }
  for (const category of [
    'coat-sleeves',
    'boot-bridges',
    'coat-collars',
    'shirt-fronts',
    'neckerchiefs',
    'waistcoats',
    'stances',
    'seated-poses',
    'first-person-sleeves',
  ]) {
    const path = resolve('tools/art/characters', category, `${id}.glb`)
    if (await Bun.file(path).exists()) {
      paths.add(path)
    }
  }
  if (id.startsWith('outlaw-')) {
    paths.add(resolve('tools/art/characters/gun-actions.single.glb'))
  }
  paths.add(resolve('bun.lock'))
  paths.add(resolve('patches/playcanvas@2.23.3.patch'))
  return [...paths].map((path) => relative(process.cwd(), path)).sort((a, b) => a.localeCompare(b))
}

export async function firstPersonNativeSource(id: string, select: (doc: Document) => void) {
  if (!Object.hasOwn(FIRST_PERSON_SLEEVE_DONORS, id)) {
    throw new Error(`No complete sleeve source for ${id}`)
  }
  const patch = resolve('tools/art/characters/first-person-sleeves', `${id}.glb`)
  if (!(await Bun.file(patch).exists())) {
    throw new Error('Run tools/content/first-person-sleeves.ts before building presentations')
  }
  const inputPaths = await inputs(id)
  const inputPins = await Promise.all(
    inputPaths.map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  )
  const directory = await mkdtemp(join(tmpdir(), 'out-west-first-person-'))
  const category = id.startsWith('outlaw-') ? 'baked' : 'equipment'
  try {
    await Promise.all(['equipment', 'baked', 'dynamic'].map((name) => mkdir(join(directory, name))))
    const encodingPath = join(directory, 'texture-encoding.json')
    await copyFile('tools/art/characters/texture-encoding.json', encodingPath)
    await withContentOutput(directory, async () => {
      await bakeCharacter(resolve('tools/art/characters', `${id}.gltf`), {
        firstPersonSleeves: true,
      })
      const path = join(directory, category, `${id}.glb`)
      const fitted = await io.read(path)
      select(fitted)
      await fitted.transform(prune({ keepAttributes: true, keepLeaves: true }))
      await io.write(path, fitted)
      await compressCharacterAssets({ encodingPath, ids: [id] })
    })
    const bytes = await readFile(join(directory, category, `${id}.glb`))
    const doc = await io.readBinary(bytes)
    const urls = new Set<string>()
    for (const material of doc.getRoot().listMaterials()) {
      for (const match of JSON.stringify(material.getExtras()).matchAll(textureUrl)) {
        if (match.groups?.url) {
          urls.add(match.groups.url)
        }
      }
    }
    const textures: PresentationTexture[] = await Promise.all(
      [...urls]
        .sort((a, b) => a.localeCompare(b))
        .map(async (url) => {
          if (!url.startsWith(prefix)) {
            throw new Error('Unexpected first-person PBR path')
          }
          const data = await readFile(join(directory, url.slice(prefix.length)))
          return { path: `public${url}`, bytes: data, sha256: hash(data) }
        }),
    )
    if (
      textures.length === 0 ||
      JSON.stringify(
        doc
          .getRoot()
          .listMaterials()
          .map((m) => m.getExtras()),
      ).includes('.webp')
    ) {
      throw new Error('First-person source must use complete native KTX2 metadata')
    }
    for (const pin of inputPins) {
      if (hash(await readFile(pin.path)) !== pin.sha256) {
        throw new Error(`Art changed during first-person bake: ${pin.path}`)
      }
    }
    return {
      bytes,
      textures,
      inputPaths,
      inputPins,
      provenance: {
        mode: 'complete-first-person-sleeves',
        nativeSHA256: hash(bytes),
        nativeBytes: bytes.length,
        textures: textures.map(({ path, sha256 }) => ({ path, sha256 })),
      },
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
