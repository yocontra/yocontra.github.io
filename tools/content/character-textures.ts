/** GPU compression through Khronos toktx and PlayCanvas' native Basis transcoder. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'

const BAKED = /^(?:player|moves|outlaw-\d+)\.glb$/u
const DYNAMIC = /^(?:dog|horse|held-rifle|held-shotgun)\.glb$/u
const directory = resolve('public/experiments/out-west/3d/native-v2/characters')
const settings = [
  '--t2',
  '--encode',
  'uastc',
  '--uastc_quality',
  '2',
  '--genmipmap',
  '--zcmp',
  '6',
  '--threads',
  '2',
]
/** Encoding inputs and settings form an immutable file key; source dimensions are unchanged. */
export async function compressedCharacterTexture(
  bytes: Uint8Array,
  color: boolean,
  scope: 'characters' | 'environments' = 'characters',
): Promise<string> {
  const encoder = process.env.KTX_ENCODER ?? Bun.which('toktx')
  if (!encoder) {
    throw new Error('Set KTX_ENCODER to Khronos toktx 4.4.2 (UASTC/KTX2), or install it on PATH')
  }
  const hash = createHash('sha256')
    .update(bytes)
    .update(JSON.stringify(settings))
    .update(color ? 'srgb' : 'linear')
    .update('toktx-4.4.2')
    .digest('hex')
    .slice(0, 24)
  const file = `${hash}.${color ? 'color' : 'data'}.ktx2`
  const target =
    scope === 'characters'
      ? directory
      : resolve('public/experiments/out-west/3d/native-v2/environments/textures')
  await mkdir(target, { recursive: true })
  const path = resolve(target, file)
  if (!(await Bun.file(path).exists())) {
    const temporary = await mkdtemp(join(tmpdir(), 'out-west-ktx-'))
    try {
      const input = join(temporary, 'source.png')
      const encoded = join(temporary, 'encoded.ktx2')
      await sharp(bytes).png().toFile(input)
      const child = Bun.spawn(
        [encoder, ...settings, '--assign_oetf', color ? 'srgb' : 'linear', encoded, input],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) {
        throw new Error(`toktx failed (${code}): ${stderr}\n${stdout}`)
      }
      await rename(encoded, path)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  return `/experiments/out-west/3d/native-v2/${scope === 'characters' ? 'characters' : 'environments/textures'}/${file}`
}

export async function compressCharacterAssets(): Promise<void> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const root = resolve('public/experiments/out-west/3d/native-v2')
  const paths = (
    await Promise.all(
      ['equipment', 'baked', 'dynamic'].map(async (category) =>
        (
          await readdir(resolve(root, category))
        )
          .filter(
            (file) =>
              file.endsWith('.glb') &&
              (category === 'equipment' ||
                (category === 'baked' && BAKED.test(file)) ||
                (category === 'dynamic' && DYNAMIC.test(file))),
          )
          .map((file) => resolve(root, category, file)),
      ),
    )
  ).flat()
  const encodingPath = resolve('tools/art/characters/texture-encoding.json')
  const previous = (await Bun.file(encodingPath).json()) as { images?: Record<string, string> }
  const documents = await Promise.all(
    paths.map(async (path) => ({ path, doc: await io.read(path) })),
  )
  const urls = new Set<string>()
  for (const { doc } of documents) {
    for (const material of doc.getRoot().listMaterials()) {
      const descriptor = material.getExtras().nativePbr
      if (descriptor) {
        for (const match of JSON.stringify(descriptor).matchAll(/"([^"\s]+\.webp)"/gu)) {
          if (match[1]) {
            urls.add(match[1])
          }
        }
      }
    }
  }
  const entries = [...urls]
  const replacements = new Map<string, string>()
  let next = 0
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < entries.length) {
        const index = next++
        const url = entries[index]
        if (!url) {
          continue
        }
        const bytes = await readFile(resolve('public', url.slice(1)))
        const result = await compressedCharacterTexture(bytes, url.includes('.color.'))
        replacements.set(url, result)
        console.log(`KTX2 ${index + 1}/${entries.length} ${basename(url)} -> ${basename(result)}`)
      }
    }),
  )
  if (process.env.KTX_ENCODE_ONLY) {
    await writeFile(
      resolve('tools/art/characters/texture-encoding.json'),
      `${JSON.stringify({ encoder: 'Khronos toktx 4.4.2', settings, images: { ...previous.images, ...Object.fromEntries(replacements) } }, null, 2)}\n`,
    )
    return
  }
  // Mutate container metadata only after every image has encoded successfully.
  for (const { path, doc } of documents) {
    if (replaceTextureMetadata(doc, replacements)) {
      await io.write(path, doc)
    }
  }
  await writeFile(
    resolve('tools/art/characters/texture-encoding.json'),
    `${JSON.stringify({ encoder: 'Khronos toktx 4.4.2', settings, images: { ...previous.images, ...Object.fromEntries(replacements) } }, null, 2)}\n`,
  )
}
if (import.meta.main) {
  await compressCharacterAssets()
}

function replaceTextureMetadata(doc: Document, replacements: ReadonlyMap<string, string>): boolean {
  let changed = false
  for (const material of doc.getRoot().listMaterials()) {
    const extras = material.getExtras()
    if (!extras.nativePbr) {
      continue
    }
    const original = JSON.stringify(extras)
    const replaced = original.replace(/"([^"\s]+\.webp)"/gu, (_match: string, url: string) =>
      JSON.stringify(replacements.get(url) ?? url),
    )
    if (original !== replaced) {
      material.setExtras(JSON.parse(replaced))
      changed = true
    }
  }
  return changed
}
