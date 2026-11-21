import { afterEach, expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { file } from 'bun'
import { preparePagesArtifact } from '../tools/prepare-pages-artifact.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const directory = 'experiments/out-west/3d/native-v2/environments/textures'
const name = `${'a'.repeat(24)}.color.ktx2`
const image = Buffer.from('test embedded KTX2 bytes')
const omission = {
  name,
  bytes: image.length,
  sha256: createHash('sha256').update(image).digest('hex'),
}
function model(extras: unknown = {}, embedded = image): Buffer<ArrayBuffer> {
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ byteLength: embedded.length }],
      bufferViews: [{ buffer: 0, byteLength: embedded.length }],
      images: [{ mimeType: 'image/ktx2', bufferView: 0 }],
      materials: [{ extras }],
    }),
  )
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20)
  json.copy(paddedJson)
  const binary = Buffer.alloc(Math.ceil(embedded.length / 4) * 4)
  embedded.copy(binary)
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46_54_6c_67)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + paddedJson.length + binary.length, 8)
  header.writeUInt32LE(paddedJson.length, 12)
  header.writeUInt32LE(0x4e_4f_53_4a, 16)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(binary.length)
  chunk.writeUInt32LE(0x00_4e_49_42, 4)
  return Buffer.concat([header, paddedJson, chunk, binary])
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'out-west-pages-'))
  temporary.push(root)
  await Promise.all(
    ['src', 'tools', 'tests', 'scripts', 'api', '.github'].map((category) =>
      mkdir(join(root, category)),
    ),
  )
  await mkdir(join(root, 'public', directory), { recursive: true })
  await writeFile(join(root, 'public', directory, name), image)
  await writeFile(join(root, 'public', 'environment.glb'), model())
  await writeFile(join(root, 'public', 'keep.txt'), 'keep every other file')
  await cp(join(root, 'public'), join(root, 'dist'), { recursive: true })
  return {
    root,
    source: join(root, 'public', directory, name),
    built: join(root, 'dist', directory, name),
    options: { root, omissions: [omission] },
  }
}

it('dry-run is read-only; pruning retains the original, GLB and unrelated artifact', async () => {
  const f = await fixture()
  expect(await preparePagesArtifact({ ...f.options, check: true })).toMatchObject({
    checked: 1,
    omittedBytes: image.length,
    checkOnly: true,
  })
  expect(await readFile(f.built)).toEqual(image)
  await preparePagesArtifact(f.options)
  expect(await file(f.built).exists()).toBe(false)
  expect(await readFile(f.source)).toEqual(image)
  expect(await readFile(join(f.root, 'dist/environment.glb'))).toEqual(model())
  expect(await readFile(join(f.root, 'dist/keep.txt'), 'utf8')).toBe('keep every other file')
})

it.each(['source', 'built'] as const)('changed %s bytes abort before deletion', async (target) => {
  const f = await fixture()
  await writeFile(f[target], Buffer.alloc(image.length))
  await expect(preparePagesArtifact(f.options)).rejects.toThrow('Omission bytes changed')
  expect(await file(f.built).exists()).toBe(true)
})

it('missing matching embedded payload aborts', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'dist/environment.glb'), model({}, Buffer.from('different')))
  await expect(preparePagesArtifact(f.options)).rejects.toThrow('identical embedded KTX2')
  expect(await file(f.built).exists()).toBe(true)
})

it.each(['public', 'dist'])('custom GLB extras consumer in %s prevents omission', async (where) => {
  const f = await fixture()
  await writeFile(
    join(f.root, where, 'environment.glb'),
    model({ nativePbr: { albedo: `/${directory}/${name}` } }),
  )
  await expect(preparePagesArtifact(f.options)).rejects.toThrow('Omission is referenced')
  expect(await file(f.built).exists()).toBe(true)
})

it.each(['src/consumer.ts', 'dist/consumer.js'])(
  'new encoded text consumer %s prevents omission',
  async (path) => {
    const f = await fixture()
    await writeFile(join(f.root, path), `fetch('/${directory}/${name.replaceAll('a', '%61')}')`)
    await expect(preparePagesArtifact(f.options)).rejects.toThrow('Omission is referenced')
    expect(await file(f.built).exists()).toBe(true)
  },
)

it('a later validation failure cannot partially prune earlier entries', async () => {
  const f = await fixture()
  await expect(
    preparePagesArtifact({
      ...f.options,
      omissions: [omission, { ...omission, name: `${'b'.repeat(24)}.data.ktx2` }],
    }),
  ).rejects.toThrow()
  expect(await file(f.built).exists()).toBe(true)
})

it('source directories and symbolic-link artifacts are refused', async () => {
  const f = await fixture()
  await expect(preparePagesArtifact({ ...f.options, directory: 'public' })).rejects.toThrow(
    'never source/public',
  )
  await symlink(f.source, join(f.root, 'dist/link.ktx2'))
  await expect(preparePagesArtifact(f.options)).rejects.toThrow('symbolic link')
  expect(await readFile(f.source)).toEqual(image)
})

it('an oversized artifact fails before removing any copy', async () => {
  const f = await fixture()
  const large = join(f.root, 'dist', 'large.bin')
  await writeFile(large, '')
  await truncate(large, 1_000_000_000) // Sparse file: exercise the real byte budget without a GB allocation.
  await expect(preparePagesArtifact(f.options)).rejects.toThrow('1,000,000,000-byte budget')
  expect(await file(f.built).exists()).toBe(true)
  expect(await readFile(f.source)).toEqual(image)
})

async function characterFixture() {
  const f = await fixture()
  const relative = 'experiments/out-west/3d/native-v2/characters'
  const intermediate = `${relative}/${'b'.repeat(24)}.color.webp`
  const ktx = `${relative}/${'c'.repeat(24)}.color.ktx2`
  const runtimeTexture = Buffer.alloc(80)
  runtimeTexture.writeUInt32LE(0x58_54_4b_ab)
  await Promise.all(
    ['public', 'dist'].map(async (where) => {
      const root = join(f.root, where)
      await mkdir(join(root, relative), { recursive: true })
      await Promise.all([
        writeFile(join(root, intermediate), 'encoder source'),
        writeFile(join(root, ktx), runtimeTexture),
        writeFile(join(root, 'actor.glb'), model({ nativePbr: { albedo: `/${ktx}` } })),
      ])
    }),
  )
  return {
    ...f,
    characterSource: join(f.root, 'public', intermediate),
    characterBuilt: join(f.root, 'dist', intermediate),
    runtimeFile: join(f.root, 'dist', ktx),
    intermediate,
    options: { ...f.options, characterEncodings: { [`/${intermediate}`]: `/${ktx}` } },
  }
}

it('keeps referenced character KTX2 textures and retires only their unused WebP inputs', async () => {
  const f = await characterFixture()
  expect(await preparePagesArtifact(f.options)).toMatchObject({ characterIntermediates: 1 })
  expect(await file(f.characterBuilt).exists()).toBe(false)
  expect(await file(f.runtimeFile).exists()).toBe(true)
  expect(await readFile(f.characterSource, 'utf8')).toBe('encoder source')
})

it('retains a character WebP if a built asset still references it', async () => {
  const f = await characterFixture()
  await writeFile(
    join(f.root, 'dist', 'consumer.js'),
    `"/${f.intermediate.replace('bbbb', '%62bbb')}"`,
  )
  expect(await preparePagesArtifact(f.options)).toMatchObject({ characterIntermediates: 0 })
  expect(await file(f.characterBuilt).exists()).toBe(true)
})

it('validates both texture copies and their encoded successor before pruning', async () => {
  const f = await characterFixture()
  await writeFile(f.runtimeFile, 'incomplete derivative')
  await expect(preparePagesArtifact(f.options)).rejects.toThrow('Character encoder inputs changed')
  expect(await file(f.characterBuilt).exists()).toBe(true)
  expect(await file(f.built).exists()).toBe(true)
})
