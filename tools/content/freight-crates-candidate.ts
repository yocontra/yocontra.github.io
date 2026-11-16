/** Staged freight authoring/assembly; published content remains the integrator's responsibility. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { withContentOutput } from './content-output.ts'
import { compressEnvironmentTextures } from './environment-textures.ts'
import {
  type FreightCell,
  type FreightCover,
  type FreightPlacement,
  type FreightSourceUv,
  packFreight,
  requireClosedFreight,
  requireFreightUv0,
  triangles,
} from './freight-crates-contract.ts'
import { inspectFreightResources } from './freight-crates-geometry.ts'
import { installFreightCrates } from './freight-crates-install.ts'
import {
  type FreightPrototype,
  freightArtifactBudget,
  prepareFreightAtlas,
  prepareFreightPrototypes,
  requireFreightReadback,
} from './freight-crates-library.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const sourcePaths = [
  'tools/art/environments/frontier.glb',
  'public/experiments/out-west/3d/native-v2/baked/frontier.glb',
  'tools/art/environments/frontier.plan.json',
  'src/experiments/out-west/content/collision.json',
]
const scripts = [
  'tools/content/freight-crates-authoring.py',
  'tools/content/freight-crates-contract.ts',
  'tools/content/freight-crates-candidate.ts',
  'tools/content/freight-crates-geometry.ts',
  'tools/content/freight-crates-library.ts',
  'tools/content/freight-crates-install.ts',
  'tools/content/environment-textures.ts',
  'tools/content/character-textures.ts',
  'tools/content/content-output.ts',
]
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
interface FileHash {
  path: string
  sha256: string
}
export interface FreightJob {
  status: string
  artifactBaselineBytes?: number
  inputs: FileHash[]
  scripts: FileHash[]
  sourceReceipt: string
  placements: FreightPlacement[]
  selected: number[]
  models: Pick<FreightCell, 'model' | 'family' | 'dimensions'>[]
}
function outsidePublic(directory: string): string {
  const target = resolve(directory)
  for (const protectedRoot of ['public', 'src', 'tools/art']) {
    const path = resolve(protectedRoot)
    if (target === path || target.startsWith(path + sep)) {
      throw new Error('Freight output must be outside protected source/public directories')
    }
  }
  return target
}
function hashes(paths: string[]): Promise<FileHash[]> {
  return Promise.all(
    paths.map(async (path) => ({ path: resolve(path), sha256: digest(await readFile(path)) })),
  )
}
export async function verifyFreightJob(directory: string): Promise<FreightJob> {
  const root = outsidePublic(directory)
  const job = JSON.parse(await readFile(join(root, 'authoring-job.json'), 'utf8')) as FreightJob
  await verifyFiles([...job.inputs, ...job.scripts])
  const receiptPath = join(root, 'source/receipt.json')
  if (digest(await readFile(receiptPath)) !== job.sourceReceipt) {
    throw new Error('Changed freight source receipt')
  }
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    files: { file: string; sha256: string }[]
    metadata: { file: string; sha256: string }[]
  }
  for (const input of [...receipt.files, ...receipt.metadata]) {
    if (digest(await readFile(join(root, 'source', input.file))) !== input.sha256) {
      throw new Error(`Changed licensed scan ${input.file}`)
    }
  }
  return job
}

export async function prepareFreight(directory: string, all = false): Promise<void> {
  const root = outsidePublic(directory)
  await mkdir(root, { recursive: true })
  const plan = JSON.parse(await readFile(sourcePaths[2] ?? '', 'utf8')) as {
    layout: { cover: FreightCover[] }
  }
  const placements = packFreight(plan.layout.cover)
  const selected = all ? placements.map((entry) => entry.coverIndex) : [2, 184, 221, 227]
  if (!selected.every((index) => placements.some((entry) => entry.coverIndex === index))) {
    throw new Error('First-look crate covers changed')
  }
  const models = [
    ...new Map(
      placements
        .filter((entry) => selected.includes(entry.coverIndex))
        .flatMap((entry) => entry.cells)
        .map(({ model, family, dimensions }) => [model, { model, family, dimensions }]),
    ).values(),
  ]
  const job: FreightJob = {
    status: all ? 'all-cover candidate; art unaccepted' : 'FOCUSED first look only; art unaccepted',
    inputs: await hashes(sourcePaths),
    scripts: await hashes(scripts),
    sourceReceipt: digest(await readFile(join(root, 'source/receipt.json'))),
    placements,
    selected,
    models,
  }
  await writeFile(join(root, 'authoring-job.json'), `${JSON.stringify(job, null, 2)}\n`)
  await verifyFreightJob(root)
  await prepareFreightAtlas(root)
  await writeFile(
    join(root, 'atlas-receipt.json'),
    `${JSON.stringify(
      {
        maps: await hashes(
          ['albedo', 'normal', 'arm'].map((kind) => join(root, `maps/freight-${kind}.png`)),
        ),
        physicalPixelsPerMetre: 1024,
        woodUVStripInteriors: [
          [0.075, 0.155],
          [0.185, 0.265],
          [0.295, 0.375],
          [0.41, 0.49],
          [0.52, 0.6],
          [0.635, 0.715],
        ],
        atlasWidth: 2048,
        note: 'Same metred scan; only three frame strip regions receive an8% albedo finish difference, not a global material gain. Panels retain source values. Right512px holds metal, irregular original crosscut and physically projected stencil. Art acceptance pending.',
      },
      null,
      2,
    )}\n`,
  )
}
async function assembleDocument(
  root: string,
  job: FreightJob,
  library: Document,
  mode: {
    input: FileHash
    name: string
    snapshots: Map<string, Buffer>
    prototypes: Map<string, FreightPrototype>
  },
) {
  const baseline = await verifyFiles([mode.input])
  const doc = await io.readBinary(Uint8Array.from(snapshot(baseline, mode.input.path)))
  const { checks, resources, unchangedNodeCount } = installFreightCrates(
    doc,
    {
      document: library,
      prototypes: mode.prototypes,
      images: ['albedo', 'normal', 'arm'].map((kind) =>
        snapshot(mode.snapshots, join(root, `maps/freight-${kind}.png`)),
      ),
    },
    job.placements,
    job.selected,
  )
  const path = join(root, `frontier-${mode.name}.glb`)
  await io.write(path, doc)
  if (mode.name === 'native') {
    await withContentOutput(join(root, 'encoded'), () => compressEnvironmentTextures(path))
  }
  const decoded = await io.read(path)
  const decodedResources = inspectFreightResources(decoded)
  const preserved = requireFreightReadback(
    await io.readBinary(Uint8Array.from(snapshot(baseline, mode.input.path))),
    decoded,
    job,
  )
  if (JSON.stringify(resources) !== JSON.stringify(decodedResources)) {
    throw new Error('Written freight geometry resources differ')
  }
  return {
    path,
    sha256: digest(await readFile(path)),
    checks,
    unchangedNodeCount,
    decodedResources,
    preserved,
    bytes: (await readFile(path)).byteLength,
  }
}
async function verifyFiles(files: FileHash[]): Promise<Map<string, Buffer>> {
  const snapshots = new Map<string, Buffer>()
  for (const file of files) {
    const bytes = await readFile(file.path)
    if (digest(bytes) !== file.sha256) {
      throw new Error(`Freight generation bytes changed ${file.path}`)
    }
    snapshots.set(resolve(file.path), bytes)
  }
  return snapshots
}
function snapshot(snapshots: Map<string, Buffer>, path: string): Buffer {
  const bytes = snapshots.get(resolve(path))
  if (!bytes) {
    throw new Error(`Missing frozen freight bytes ${path}`)
  }
  return bytes
}
export async function assembleFreight(directory: string): Promise<void> {
  const root = outsidePublic(directory)
  const job = await verifyFreightJob(root)
  const author = JSON.parse(await readFile(join(root, 'author-receipt.json'), 'utf8')) as {
    outputs: FileHash[]
    inputs: FileHash[]
    pieces: FreightSourceUv[]
  }
  const atlasReceipt = JSON.parse(await readFile(join(root, 'atlas-receipt.json'), 'utf8')) as {
    maps: FileHash[]
  }
  const snapshots = await verifyFiles([...author.outputs, ...author.inputs, ...atlasReceipt.maps])
  const library = await io.readBinary(
    Uint8Array.from(snapshot(snapshots, join(root, 'crate-library.glb'))),
  )
  const sourceUVs = requireFreightUv0(library, author.pieces)
  for (const node of library.getRoot().listNodes()) {
    if (node.getMesh()) {
      requireClosedFreight(triangles(node, true))
    }
  }
  const prototypes = await prepareFreightPrototypes(library)
  const outputs: Awaited<ReturnType<typeof assembleDocument>>[] = []
  for (const [index, name] of ['canonical', 'native'].entries()) {
    const input = job.inputs[index]
    if (!input) {
      throw new Error('Missing freight baseline')
    }
    outputs.push(await assembleDocument(root, job, library, { input, name, snapshots, prototypes }))
  }
  const native = outputs[1]
  const input = job.inputs[1]
  if (!(native && input)) {
    throw new Error('Missing native artifact budget inputs')
  }
  const artifactBudget = freightArtifactBudget(
    job.artifactBaselineBytes ?? 0,
    (await readFile(input.path)).byteLength,
    native.bytes,
  )
  await writeFile(
    join(root, 'assembly-receipt.json'),
    `${JSON.stringify({ status: 'staged first look only; independent art review required', jobSHA256: digest(await readFile(join(root, 'authoring-job.json'))), authorReceiptSHA256: digest(await readFile(join(root, 'author-receipt.json'))), sourceUVs, outputs, artifactBudget }, null, 2)}\n`,
  )
}
/** Read/verify bytes once; request handlers must not reread mutable files after provenance capture. */
export async function frozenFreightReview(directory: string) {
  const root = outsidePublic(directory)
  const job = await verifyFreightJob(root)
  const assemblyBytes = await readFile(join(root, 'assembly-receipt.json'))
  const assembly = JSON.parse(assemblyBytes.toString()) as {
    jobSHA256: string
    authorReceiptSHA256: string
    outputs: FileHash[]
  }
  const jobBytes = await readFile(join(root, 'authoring-job.json'))
  const authorBytes = await readFile(join(root, 'author-receipt.json'))
  if (
    digest(jobBytes) !== assembly.jobSHA256 ||
    digest(authorBytes) !== assembly.authorReceiptSHA256
  ) {
    throw new Error('Freight generation receipt chain differs')
  }
  const author = JSON.parse(authorBytes.toString()) as { inputs: FileHash[]; outputs: FileHash[] }
  await verifyFiles([...author.inputs, ...author.outputs])
  const atlasReceipt = JSON.parse(await readFile(join(root, 'atlas-receipt.json'), 'utf8')) as {
    maps: FileHash[]
  }
  await verifyFiles(atlasReceipt.maps)
  const baselineInput = job.inputs[1]
  const output = assembly.outputs.find((file) => file.path === join(root, 'frontier-native.glb'))
  if (!(baselineInput && output)) {
    throw new Error('Missing freight native proof assets')
  }
  const baseline = await readFile(baselineInput.path)
  const candidate = await readFile(output.path)
  if (digest(baseline) !== baselineInput.sha256 || digest(candidate) !== output.sha256) {
    throw new Error('Freight served asset differs from receipt')
  }
  return {
    job,
    baseline,
    candidate,
    provenance: {
      assemblySHA256: digest(assemblyBytes),
      baseline: baselineInput,
      candidate: output,
      jobSHA256: digest(jobBytes),
      authorReceiptSHA256: digest(authorBytes),
    },
  }
}
if (import.meta.main) {
  const [command, directory] = process.argv.slice(2)
  if (!directory) {
    throw new Error(
      'Usage: freight-crates-candidate.ts prepare|assemble EXTERNAL_DIRECTORY [--all]',
    )
  }
  if (command === 'prepare') {
    await prepareFreight(directory, process.argv.includes('--all'))
  } else if (command === 'assemble') {
    await assembleFreight(directory)
  } else {
    throw new Error('Unknown freight candidate operation')
  }
}
