/** Keep referenced game textures and omit verified encoder intermediates from Pages. */
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import characterEncoding from './art/characters/texture-encoding.json' with { type: 'json' }
import omissions from './content/pages-artifact-omissions.json' with { type: 'json' }

const textureDirectory = 'experiments/out-west/3d/native-v2/environments/textures'
const characterDirectory = 'experiments/out-west/3d/native-v2/characters'
const characterTexture = /[a-f0-9]{24}\.(?:color|data)\.(?:webp|ktx2)/gu
const characterInput = /^(?<name>[a-f0-9]{24}\.(?:color|data))\.webp$/u
const textExtensions = /\.(?:ts|js|json|jsonc|gltf|md|html|ya?ml|toml|css|svg|txt|map)$/u
const omissionName = /^[0-9a-f]{24}\.(?:color|data)\.ktx2$/u
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface Omission {
  name: string
  bytes: number
  sha256: string
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link: ${path}`)
    }
    if (entry.isDirectory()) {
      result.push(...(await files(path)))
    } else if (entry.isFile()) {
      result.push(path)
    }
  }
  return result
}

function glb(bytes: Buffer, path: string): { json: unknown; images: string[] } {
  if (
    bytes.length < 20 ||
    bytes.readUInt32LE(0) !== 0x46_54_6c_67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e_4f_53_4a
  ) {
    throw new Error(`Invalid GLB: ${path}`)
  }
  const end = 20 + bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, end).toString()) as {
    images?: { mimeType?: string; bufferView?: number }[]
    bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number }[]
  }
  const images: string[] = []
  if (end < bytes.length) {
    if (end + 8 > bytes.length || bytes.readUInt32LE(end + 4) !== 0x00_4e_49_42) {
      throw new Error(`Invalid GLB binary chunk: ${path}`)
    }
    const blob = bytes.subarray(end + 8)
    if (bytes.readUInt32LE(end) !== blob.length) {
      throw new Error(`Invalid GLB binary length: ${path}`)
    }
    for (const image of json.images ?? []) {
      if (image.mimeType !== 'image/ktx2' || image.bufferView === undefined) {
        continue
      }
      const view = json.bufferViews?.[image.bufferView]
      const offset = view?.byteOffset ?? 0
      if (!view || (view.buffer ?? 0) !== 0 || offset + view.byteLength > blob.length) {
        throw new Error(`Invalid embedded image: ${path}`)
      }
      images.push(hash(blob.subarray(offset, offset + view.byteLength)))
    }
  }
  return { json, images }
}

/** Scan all strings, including custom extras and percent-encoded external URIs. */
function references(value: unknown, names: Set<string>, path: string, textures: Set<string>): void {
  if (typeof value === 'string') {
    const decoded = value.replace(/%(?<hex>[0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    for (const match of decoded.matchAll(characterTexture)) {
      textures.add(match[0])
    }
    for (const name of names) {
      if (value.includes(name) || decoded.includes(name)) {
        throw new Error(`Omission is referenced: ${name} in ${path}`)
      }
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      references(child, names, path, textures)
    }
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      references(child, names, path, textures)
    }
  }
}

async function inspectFiles(paths: string[], names: Set<string>) {
  const textures = new Set<string>()
  const images = new Set<string>()
  for (const path of paths) {
    if (path.endsWith('.glb')) {
      const parsed = glb(await readFile(path), path)
      references(parsed.json, names, path, textures)
      for (const digest of parsed.images) {
        images.add(digest)
      }
    } else if (textExtensions.test(path)) {
      references(await readFile(path, 'utf8'), names, path, textures)
    }
  }
  return { images, textures }
}

async function inspectSources(root: string, names: Set<string>): Promise<Set<string>> {
  const textures = new Set<string>()
  // Offline tools/tests keep reading public originals. Reject new named consumers conservatively.
  const manifest = resolve(
    dirname(new URL(import.meta.url).pathname),
    'content/pages-artifact-omissions.json',
  )
  for (const category of ['src', 'tools', 'tests', 'scripts', 'api', '.github']) {
    for (const path of await files(join(root, category))) {
      if (
        path !== manifest &&
        path !== join(root, 'tools/art/characters/texture-encoding.json') &&
        textExtensions.test(path)
      ) {
        references(await readFile(path, 'utf8'), names, path, textures)
      }
    }
  }
  return textures
}

async function omitCharacterInputs(
  encodings: Readonly<Record<string, string>>,
  roots: { public: string; artifact: string },
  bakedReferences: Set<string>,
  allReferences: Set<string>,
): Promise<{ paths: string[]; bytes: number }> {
  const paths: string[] = []
  let bytes = 0
  for (const [source, derivative] of Object.entries(encodings)) {
    if (
      !(
        source.startsWith(`/${characterDirectory}/`) &&
        derivative.startsWith(`/${characterDirectory}/`)
      )
    ) {
      continue
    }
    const name = characterInput.exec(source.slice(characterDirectory.length + 2))?.groups?.name
    const encoded = derivative.slice(characterDirectory.length + 2)
    if (
      !(
        name &&
        omissionName.test(encoded) &&
        bakedReferences.has(encoded) &&
        !allReferences.has(`${name}.webp`)
      )
    ) {
      continue
    }
    const built = join(roots.artifact, source.slice(1))
    const original = join(roots.public, source.slice(1))
    if (!((await Bun.file(original).exists()) && (await Bun.file(built).exists()))) {
      continue
    }
    const [a, b, runtime, originalRuntime] = await Promise.all([
      readFile(original),
      readFile(built),
      readFile(join(roots.artifact, derivative.slice(1))),
      readFile(join(roots.public, derivative.slice(1))),
    ])
    if (
      !(a.equals(b) && runtime.equals(originalRuntime)) ||
      runtime.length < 80 ||
      runtime.readUInt32LE() !== 0x58_54_4b_ab
    ) {
      throw new Error(`Character encoder inputs changed: ${source}`)
    }
    paths.push(built)
    bytes += b.length
  }
  return { paths, bytes }
}

export async function preparePagesArtifact(
  options: {
    root?: string
    directory?: string
    check?: boolean
    omissions?: readonly Omission[]
    characterEncodings?: Readonly<Record<string, string>>
  } = {},
) {
  const root = await realpath(options.root ?? process.cwd())
  const directory = await realpath(resolve(root, options.directory ?? 'dist'))
  const publicRoot = await realpath(join(root, 'public'))
  const location = relative(root, directory)
  if (
    !location ||
    (!(location.startsWith('..') || isAbsolute(location)) && location.split('/')[0] !== 'dist') ||
    !relative(directory, publicRoot).startsWith('..')
  ) {
    throw new Error('Artifact must be dist or an external build directory, never source/public')
  }
  const selected = options.omissions ?? omissions
  const names = new Set(selected.map((entry) => entry.name))
  if (names.size !== selected.length) {
    throw new Error('Duplicate omission')
  }
  for (const entry of selected) {
    if (!omissionName.test(entry.name)) {
      throw new Error(`Invalid omission name: ${entry.name}`)
    }
  }
  const artifactFiles = await files(directory)
  const beforeBytes = (
    await Promise.all(artifactFiles.map(async (path) => (await stat(path)).size))
  ).reduce((sum, bytes) => sum + bytes, 0)
  const embedded = {
    public: await inspectFiles(await files(publicRoot), names),
    artifact: await inspectFiles(artifactFiles, names),
  }
  const sourceReferences = await inspectSources(root, names)
  const removals: string[] = []
  let omittedBytes = 0
  for (const entry of selected) {
    const path = join(textureDirectory, entry.name)
    const source = await readFile(join(publicRoot, path))
    const built = await readFile(join(directory, path))
    if (
      source.length !== entry.bytes ||
      built.length !== entry.bytes ||
      hash(source) !== entry.sha256 ||
      hash(built) !== entry.sha256
    ) {
      throw new Error(`Omission bytes changed: ${entry.name}`)
    }
    if (!(embedded.public.images.has(entry.sha256) && embedded.artifact.images.has(entry.sha256))) {
      throw new Error(`Omission lacks identical embedded KTX2: ${entry.name}`)
    }
    omittedBytes += entry.bytes
    removals.push(join(directory, path))
  }
  const characters = await omitCharacterInputs(
    options.characterEncodings ?? characterEncoding.images,
    { public: publicRoot, artifact: directory },
    embedded.artifact.textures,
    new Set([...embedded.public.textures, ...embedded.artifact.textures, ...sourceReferences]),
  )
  removals.push(...characters.paths)
  omittedBytes += characters.bytes
  const afterBytes = beforeBytes - omittedBytes
  if (afterBytes > 1_000_000_000) {
    throw new Error(`Pages artifact exceeds 1,000,000,000-byte budget: ${afterBytes}`)
  }
  // All checks precede mutation: a stale allowlist cannot partially prune an artifact.
  if (!options.check) {
    for (const path of removals) {
      await unlink(path)
    }
  }
  return {
    checked: selected.length,
    characterIntermediates: characters.paths.length,
    omittedBytes,
    beforeBytes,
    afterBytes,
    directory,
    checkOnly: Boolean(options.check),
  }
}

if (import.meta.main) {
  const directory = process.argv.find((arg) => arg.startsWith('--dir='))?.slice(6)
  console.log(
    await preparePagesArtifact({
      ...(directory ? { directory } : {}),
      check: process.argv.includes('--check'),
    }),
  )
}
