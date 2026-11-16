import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { type Accessor, type Document, type Mesh, type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { getBounds, mergeDocuments } from '@gltf-transform/functions'
import sharp from 'sharp'
import { withContentOutput } from './content-output.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
export const CACTUS_MESH = 'cactus.saguaro_one_arm'
export const CACTUS_MATERIAL = 'Cactus near prototype skin'
const SOURCE_GEOMETRY_HASH = 'c8c38f18c605efd4f1b2ef2114ffabf9b0e9ca9d166ed25a93c385bfc03bcdc1'
export const cactusHash = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')
export function cactusRequired<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Missing required cactus data')
  }
  return value
}
interface FileRecord {
  path: string
  sha256: string
}
export interface CactusJob {
  donor: string
  environment: string
  target: { name: string; center: number[]; bounds: ReturnType<typeof getBounds> }
  inputs: FileRecord[]
  scripts: FileRecord[]
  budget: number
  reusedMaps?: FileRecord[]
}
const scripts = [
  'tools/content/frontier-cactus-authoring.py',
  'tools/content/frontier-cactus-candidate.ts',
  'tools/test-playcanvas-frontier-cactus.ts',
  'tests/content-playcanvas/frontier-cactus-candidate.test.ts',
  'tools/content/content-output.ts',
  'tools/content/environment-textures.ts',
  'tools/content/character-textures.ts',
]
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)
/** Resolve ancestors before mkdir: a symlink alias cannot create a directory in any checkout. */
export async function cactusStage(path: string): Promise<string> {
  const target = resolve(path)
  let ancestor = target
  while (!(await stat(ancestor).catch(() => null))) {
    ancestor = dirname(ancestor)
  }
  const canonical = resolve(await realpath(ancestor), relative(ancestor, target))
  if (inside(canonical, await realpath(process.cwd()))) {
    throw new Error('Cactus staging must be outside a checkout')
  }
  for (let cursor = canonical; cursor !== dirname(cursor); cursor = dirname(cursor)) {
    if (await stat(join(cursor, '.git')).catch(() => null)) {
      throw new Error('Cactus staging must be outside a checkout')
    }
  }
  await mkdir(canonical, { recursive: true })
  return canonical
}
function vector(values: number[], count: number): number[] {
  if (values.length !== count || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Invalid cactus vector')
  }
  return values
}
export function cactusDensity(mesh: Mesh): number {
  let area = 0
  let uvArea = 0
  for (const primitive of mesh.listPrimitives()) {
    const position = cactusRequired(primitive.getAttribute('POSITION'))
    const uv = cactusRequired(primitive.getAttribute('TEXCOORD_0'))
    const indices = cactusRequired(primitive.getIndices())
    for (let t = 0; t < indices.getCount(); t += 3) {
      const point = (offset: number) =>
        vector(position.getElement(indices.getScalar(t + offset), []), 3)
      const a = point(0)
      const b = point(1).map((v, i) => v - cactusRequired(a[i]))
      const c = point(2).map((v, i) => v - cactusRequired(a[i]))
      const [bx = 0, by = 0, bz = 0] = b
      const [cx = 0, cy = 0, cz = 0] = c
      area += Math.hypot(by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx) / 2
      const [u0 = 0, v0 = 0] = vector(uv.getElement(indices.getScalar(t), []), 2)
      const [u1 = 0, v1 = 0] = vector(uv.getElement(indices.getScalar(t + 1), []), 2)
      const [u2 = 0, v2 = 0] = vector(uv.getElement(indices.getScalar(t + 2), []), 2)
      uvArea += Math.abs((u1 - u0) * (v2 - v0) - (v1 - v0) * (u2 - u0)) / 2
    }
  }
  const density = 512 * Math.sqrt(uvArea / area)
  if (!(Number.isFinite(density) && density > 0)) {
    throw new Error('Invalid cactus UV density')
  }
  return density
}
const records = async (paths: string[]): Promise<FileRecord[]> =>
  Promise.all(
    paths.map(async (path) => ({ path: resolve(path), sha256: cactusHash(await readFile(path)) })),
  )
export async function verifyCactusFiles(files: readonly FileRecord[]): Promise<void> {
  for (const file of files) {
    if (cactusHash(await readFile(file.path)) !== file.sha256) {
      throw new Error(`Changed cactus input: ${file.path}`)
    }
  }
}
export async function freezeCactusFiles(
  files: readonly FileRecord[],
): Promise<Map<string, Buffer>> {
  const frozen = new Map<string, Buffer>()
  for (const file of files) {
    const bytes = await readFile(file.path)
    if (cactusHash(bytes) !== file.sha256) {
      throw new Error(`Changed cactus input: ${file.path}`)
    }
    frozen.set(file.path, bytes)
  }
  return frozen
}
export function cactusMeshSignature(mesh: Mesh, geometryOnly = false): string {
  return cactusHash(
    JSON.stringify(
      mesh.listPrimitives().map((primitive) => ({
        mode: primitive.getMode(),
        material: geometryOnly ? null : primitive.getMaterial()?.getName(),
        indices: primitive.getIndices()?.getArray(),
        attributes: primitive
          .listSemantics()
          .filter((s) => !geometryOnly || s === 'POSITION')
          .map((semantic) => ({
            semantic,
            type: primitive.getAttribute(semantic)?.getType(),
            normalized: primitive.getAttribute(semantic)?.getNormalized(),
            array: primitive.getAttribute(semantic)?.getArray(),
          })),
      })),
    ),
  )
}
function boundCenter(node: Node): number[] {
  const bounds = getBounds(node)
  return bounds.min.map((value, axis) => (value + cactusRequired(bounds.max[axis])) / 2)
}
export function cactusTarget(doc: Document): Node {
  const candidates = doc
    .getRoot()
    .listNodes()
    .filter((node) => {
      if (node.getMesh()?.getName() !== CACTUS_MESH) {
        return false
      }
      const [x = 0, , z = 0] = boundCenter(node)
      return Math.abs(x - 3.5) < 0.1 && Math.abs(z - 16.5) < 0.1
    })
  if (candidates.length !== 1) {
    throw new Error(`Expected one main yard prototype, found ${candidates.length}`)
  }
  return cactusRequired(candidates[0])
}
export function cactusRemainder(doc: Document): string {
  const target = cactusTarget(doc)
  const meshHashes = new Map(
    doc
      .getRoot()
      .listMeshes()
      .map((mesh) => [mesh, cactusMeshSignature(mesh)]),
  )
  return cactusHash(
    JSON.stringify({
      nodes: doc
        .getRoot()
        .listNodes()
        .map((node) => ({
          name: node.getName(),
          matrix: node.getMatrix(),
          extras: node.getExtras(),
          mesh: node === target ? 'prototype' : (meshHashes.get(node.getMesh() as Mesh) ?? null),
        })),
      textures: doc
        .getRoot()
        .listTextures()
        .filter((texture) => !texture.getName().startsWith('Cactus near '))
        .map((texture) => ({
          name: texture.getName(),
          uri: texture.getURI(),
          mime: texture.getMimeType(),
          sha256: cactusHash(texture.getImage() ?? new Uint8Array()),
        })),
    }),
  )
}
const boundsError = (a: ReturnType<typeof getBounds>, b: ReturnType<typeof getBounds>) =>
  Math.max(
    ...[...a.min, ...a.max].map((v, i) => Math.abs(v - cactusRequired([...b.min, ...b.max][i]))),
  )
function requireParts(parts: Document, donor: Document) {
  const source = donor
    .getRoot()
    .listNodes()
    .find((node) => node.getMesh()?.getName() === CACTUS_MESH)
  const part = parts
    .getRoot()
    .listNodes()
    .find((node) => node.getMesh())
  if (!(source && part) || parts.getRoot().listMeshes().length !== 1) {
    throw new Error('Expected exactly one authored cactus mesh')
  }
  const geometry = cactusRequired(part.getMesh())
  const densityRatio = cactusDensity(geometry) / cactusDensity(cactusRequired(source.getMesh()))
  if (!(densityRatio >= 0.9 && densityRatio <= 1.1)) {
    throw new Error('Cactus physical UV density changed by more than ten percent')
  }
  const triangles = geometry
    .listPrimitives()
    .reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? 0) / 3, 0)
  const shapeError = boundsError(getBounds(part), getBounds(source))
  if (!(triangles > 0 && triangles <= 20_000 && shapeError <= 0.04)) {
    throw new Error('Cactus triangle budget or donor envelope changed')
  }
  if (part.getMatrix().some((value, i) => Math.abs(value - (i % 5 === 0 ? 1 : 0)) > 0.000_001)) {
    throw new Error('Authored prototype must retain the identity donor pivot')
  }
  for (const primitive of geometry.listPrimitives()) {
    if (!['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'].every((s) => primitive.getAttribute(s))) {
      throw new Error('Cactus needs position, normal, authored UV0 and vertex tint')
    }
    const m = primitive.getMaterial()
    if (
      !(
        m?.getBaseColorTexture() &&
        m.getNormalTexture() &&
        m.getMetallicRoughnessTexture() &&
        m.getOcclusionTexture()
      )
    ) {
      throw new Error('Cactus needs all native PBR maps')
    }
    if (m.getMetallicFactor() !== 0 || m.getName() !== CACTUS_MATERIAL) {
      throw new Error('Unexpected cactus prototype material')
    }
  }
  return { geometry, triangles, densityRatio }
}
/** One node gets a private mesh/material; every original resource and other instance is retained. */
export function replaceCactusPrototype(doc: Document, parts: Document, donor: Document) {
  const target = cactusTarget(doc)
  const { geometry, triangles, densityRatio } = requireParts(parts, donor)
  const meshes = doc
    .getRoot()
    .listMeshes()
    .map((mesh) => [mesh, cactusMeshSignature(mesh)] as const)
  const nodes = doc
    .getRoot()
    .listNodes()
    .map((node) => [node, node.getMesh(), node.getMatrix()] as const)
  const textures = doc
    .getRoot()
    .listTextures()
    .map((t) => [t, cactusHash(t.getImage() ?? new Uint8Array()), t.getURI()] as const)
  const bounds = getBounds(target)
  const copied = mergeDocuments(doc, parts)
  target.setMesh((cactusRequired(copied.get(geometry)) as Mesh).setName(CACTUS_MESH))
  for (const scene of parts.getRoot().listScenes()) {
    copied.get(scene)?.dispose()
  }
  for (const node of parts.getRoot().listNodes()) {
    copied.get(node)?.dispose()
  }
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  for (const accessor of parts.getRoot().listAccessors()) {
    ;(copied.get(accessor) as Accessor | undefined)?.setBuffer(buffer)
  }
  for (const imported of parts.getRoot().listBuffers()) {
    copied.get(imported)?.dispose()
  }
  const wm = target.getWorldMatrix()
  for (const primitive of cactusRequired(target.getMesh()).listPrimitives()) {
    const position = cactusRequired(primitive.getAttribute('POSITION'))
    const values = new Float32Array(position.getCount() * 2)
    for (let i = 0; i < position.getCount(); i++) {
      const [x = 0, y = 0, z = 0] = position.getElement(i, [])
      values[i * 2] =
        ((wm[0] ?? 0) * x + (wm[4] ?? 0) * y + (wm[8] ?? 0) * z + (wm[12] ?? 0)) / 1024
      values[i * 2 + 1] =
        ((wm[2] ?? 0) * x + (wm[6] ?? 0) * y + (wm[10] ?? 0) * z + (wm[14] ?? 0)) / 1024
    }
    primitive.setAttribute(
      'TEXCOORD_1',
      doc.createAccessor().setType('VEC2').setArray(values).setBuffer(buffer),
    )
  }
  const worldBounds = getBounds(target)
  const worldEnvelopeMaxErrorM = boundsError(bounds, worldBounds)
  if (worldEnvelopeMaxErrorM > 0.04) {
    throw new Error('Cactus world bounds changed')
  }
  if (
    meshes.some(([mesh, hash]) => cactusMeshSignature(mesh) !== hash) ||
    nodes.some(
      ([node, mesh, matrix]) =>
        (node !== target && node.getMesh() !== mesh) ||
        JSON.stringify(node.getMatrix()) !== JSON.stringify(matrix),
    ) ||
    textures.some(
      ([t, hash, uri]) =>
        cactusHash(t.getImage() ?? new Uint8Array()) !== hash || t.getURI() !== uri,
    )
  ) {
    throw new Error('Unrelated cactus environment resources changed')
  }
  return {
    triangles,
    replaced: 1,
    densityRatio,
    bounds,
    worldEnvelopeMaxErrorM,
    worldEnvelopeArtLimitM: 0.04,
    untouchedMeshes: meshes.length,
    untouchedTextures: textures.length,
  }
}
async function prepare(
  directory: string,
  environment: string,
  mapsDirectory?: string,
): Promise<void> {
  const stage = await cactusStage(directory)
  const donor = resolve('tools/art/environments/frontier-cacti.glb')
  const doc = await io.read(environment)
  if (
    cactusMeshSignature(cactusRequired(cactusTarget(doc).getMesh()), true) !== SOURCE_GEOMETRY_HASH
  ) {
    throw new Error('Expected unchanged original yard cactus geometry')
  }
  const target = cactusTarget(doc)
  const job: CactusJob = {
    donor,
    environment: resolve(environment),
    target: { name: target.getName(), center: boundCenter(target), bounds: getBounds(target) },
    inputs: await records([
      donor,
      environment,
      ...['diff', 'nor', 'arm'].map(
        (role) => `tools/art/environments/textures/saguaro_skin_${role}.webp`,
      ),
    ]),
    scripts: await records(scripts),
    budget: 20_000,
  }
  if (mapsDirectory) {
    const source = resolve(mapsDirectory)
    const receiptPath = join(source, 'authoring-receipt.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { files: FileRecord[] }
    const names = ['near-albedo.png', 'near-normal.png', 'near-arm.png', 'tile-source.blend']
    const files = names.map((name) =>
      cactusRequired(receipt.files.find((f) => resolve(f.path) === join(source, name))),
    )
    await verifyCactusFiles(files)
    job.reusedMaps = files
    job.inputs.push(...files, ...(await records([receiptPath])))
  }
  await Promise.all(
    [...(await freezeCactusFiles(job.scripts))].map(async ([path, bytes]) => {
      const snapshot = join(stage, 'producer-code', relative(process.cwd(), path))
      await mkdir(dirname(snapshot), { recursive: true })
      await writeFile(snapshot, bytes)
    }),
  )
  await writeFile(join(stage, 'authoring-job.json'), `${JSON.stringify(job, null, 2)}\n`)
}
export async function verifyCactusJob(directory: string): Promise<CactusJob> {
  const job = JSON.parse(await readFile(join(directory, 'authoring-job.json'), 'utf8')) as CactusJob
  const expected = scripts.map((path) => resolve(path)).sort((a, b) => a.localeCompare(b))
  if (
    JSON.stringify(job.scripts.map((file) => file.path).sort((a, b) => a.localeCompare(b))) !==
      JSON.stringify(expected) ||
    job.donor !== resolve('tools/art/environments/frontier-cacti.glb') ||
    !job.inputs.some((file) => file.path === job.environment)
  ) {
    throw new Error('Incomplete cactus generation inputs/scripts')
  }
  if (![3000, 20_000].includes(job.budget)) {
    throw new Error('Changed cactus budget contract')
  }
  const producerScripts = await Promise.all(
    job.scripts.map(async (file) => {
      const snapshot = join(directory, 'producer-code', relative(process.cwd(), file.path))
      return {
        ...file,
        path: await stat(snapshot)
          .then(() => snapshot)
          .catch(() => file.path),
      }
    }),
  )
  await verifyCactusFiles([...job.inputs, ...producerScripts])
  return { ...job, scripts: producerScripts }
}
async function assemble(directory: string): Promise<void> {
  const stage = await cactusStage(directory)
  const assembler = await records([import.meta.path])
  const job = await verifyCactusJob(stage)
  const receipt = JSON.parse(await readFile(join(stage, 'authoring-receipt.json'), 'utf8')) as {
    jobSHA256: string
    files: FileRecord[]
  }
  if (receipt.jobSHA256 !== cactusHash(await readFile(join(stage, 'authoring-job.json')))) {
    throw new Error('Changed cactus authoring job')
  }
  await verifyCactusFiles(receipt.files)
  const required = ['near.glb', 'near-albedo.png', 'near-normal.png', 'near-arm.png'].map((name) =>
    join(stage, name),
  )
  if (required.some((path) => !receipt.files.some((file) => resolve(file.path) === path))) {
    throw new Error('Authoring receipt does not bind actual near output/maps')
  }
  for (const path of required.slice(1)) {
    const metadata = await sharp(path).metadata()
    if (metadata.width !== 512 || metadata.height !== 512) {
      throw new Error('Cactus maps must retain the reviewed 512-square UV tile')
    }
  }
  const [doc, parts, donor] = await Promise.all([
    io.read(job.environment),
    io.read(required[0] ?? ''),
    io.read(job.donor),
  ])
  const remainder = cactusRemainder(doc)
  const arm = parts
    .createTexture('Cactus near ARM')
    .setImage(await readFile(join(stage, 'near-arm.png')))
    .setMimeType('image/png')
  const material = parts
    .createMaterial(CACTUS_MATERIAL)
    .setBaseColorFactor([0.95, 0.8, 0.9, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setBaseColorTexture(
      parts
        .createTexture('Cactus near albedo')
        .setImage(await readFile(join(stage, 'near-albedo.png')))
        .setMimeType('image/png'),
    )
    .setNormalTexture(
      parts
        .createTexture('Cactus near normal')
        .setImage(await readFile(join(stage, 'near-normal.png')))
        .setMimeType('image/png'),
    )
    .setMetallicRoughnessTexture(arm)
    .setOcclusionTexture(arm)
  for (const mesh of parts.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitive.setMaterial(material)
    }
  }
  const result = replaceCactusPrototype(doc, parts, donor)
  const output = join(stage, 'frontier-cactus.glb')
  await io.write(output, doc)
  await withContentOutput(join(stage, 'codec'), () => compressEnvironmentTextures(output))
  if (cactusRemainder(await io.read(output)) !== remainder) {
    throw new Error('Decoded unrelated environment changed after codec/GLB readback')
  }
  await verifyCactusFiles([...job.inputs, ...job.scripts, ...receipt.files, ...assembler])
  await writeFile(
    join(stage, 'candidate-receipt.json'),
    `${JSON.stringify(
      {
        status: 'unaccepted one-arm near art prototype',
        ...result,
        job,
        authoringReceiptSHA256: cactusHash(await readFile(join(stage, 'authoring-receipt.json'))),
        files: [
          ...(await records([
            join(stage, 'authoring-job.json'),
            join(stage, 'authoring-receipt.json'),
          ])),
          ...receipt.files,
          ...assembler,
        ],
        output: { path: output, sha256: cactusHash(await readFile(output)) },
      },
      null,
      2,
    )}\n`,
  )
}
if (import.meta.main) {
  const [command, directory, environment, mapsDirectory] = process.argv.slice(2)
  if (command === 'prepare' && directory && environment) {
    await prepare(directory, environment, mapsDirectory)
  } else if (command === 'assemble' && directory) {
    await assemble(directory)
  } else {
    throw new Error('Use prepare STAGE SOURCE_GLB [MAP_STAGE], then Blender, then assemble STAGE')
  }
}
