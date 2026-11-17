/** Explicit offline staging only; publication remains the normal reviewed content transaction. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import recipe from '../../src/experiments/out-west/content/environment-props.json' with {
  type: 'json',
}
import { appendBarrelVariants } from './barrel-install.ts'
import { buildBarrelParts } from './barrel-parts.ts'
import { frontierIO } from './frontier-geometry.ts'
import { readMountGlb } from './frontier-mounts-install.ts'

const donor = 'tools/art/environments/frontier-library.glb'
const sources = [
  donor,
  'src/experiments/out-west/content/environment-props.json',
  'src/experiments/out-west/content/environment-props.ts',
  'tools/content/barrel-parts.ts',
  'tools/content/barrel-topology.ts',
  'tools/content/barrel-install.ts',
  'tools/content/barrels.ts',
  'tools/content/frontier-geometry.ts',
  'tools/content/frontier-mounts-install.ts',
  'tools/content/authoring-inputs.ts',
  'bun.lock',
]
const metadataKey = /"sourceHash"\s*:/gu
const metadataToken = /"sourceHash"\s*:\s*"(?<digest>[a-f0-9]{64})"/u
const sourceHash = /^[a-f0-9]{64}$/u
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** Replace the one root hash token, preserving every nonowned metadata byte, including formatting. */
export function barrelMetadata(bytes: Uint8Array, expected: string, next: string): Uint8Array {
  if (!(sourceHash.test(expected) && sourceHash.test(next))) {
    throw new Error('Invalid canonical SHA256')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Frontier metadata')
  }
  if (Reflect.get(parsed, 'sourceHash') !== expected) {
    throw new Error('Frontier metadata sourceHash does not match input canonical')
  }
  const matches = [...text.matchAll(metadataKey)]
  const match = text.match(metadataToken)
  if (
    matches.length !== 1 ||
    !match ||
    match.index === undefined ||
    match.groups?.digest !== expected
  ) {
    throw new Error('Ambiguous Frontier metadata sourceHash')
  }
  const at = match.index + match[0].indexOf(expected)
  return Buffer.from(text.slice(0, at) + next + text.slice(at + expected.length))
}
export async function stageBarrels(options: {
  canonical: string
  native: string
  metadata?: string
  output: string
}) {
  const output = resolve(options.output)
  if (!isAbsolute(options.output) || output.startsWith(`${resolve('.')}${sep}`)) {
    throw new Error('Use a new absolute staging directory outside the checkout')
  }
  const canonical = await readFile(options.canonical)
  const native = await readFile(options.native)
  const canonicalHash = hash(canonical)
  const metadataPath = options.metadata ?? join(dirname(options.canonical), 'frontier.json')
  const metadata = await readFile(metadataPath)
  // Metadata is an input snapshot, like the original canonical/native, not a self-invalidating prefab dependency.
  barrelMetadata(metadata, canonicalHash, canonicalHash)
  if (canonicalHash !== recipe.sourceCanonicalSha256) {
    throw new Error('Rebase authored barrel bindings before changing the canonical input')
  }
  if (readMountGlb(native).json.extras?.frontierSourceHash !== canonicalHash) {
    throw new Error('Stale native input')
  }
  const inputs = await Promise.all(
    sources.map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  )
  const library = await frontierIO.read(donor)
  const node = library
    .getRoot()
    .listNodes()
    .find((entry) => entry.getName() === 'barrel_kit')
  const primitive = node?.getMesh()?.listPrimitives()[0]
  if (!primitive) {
    throw new Error('Missing actual barrel donor')
  }
  const parts = buildBarrelParts(primitive)
  for (const doc of [parts.library, parts.fragments]) {
    doc.getRoot().setExtras({
      sourceInputs: inputs,
      bindingCanonicalSha256: canonicalHash,
      recipe: 'donor-timber-lengthening-and-closed-fragments-v1',
    })
  }
  const libraryBytes = await frontierIO.writeBinary(parts.library)
  const fragmentBytes = await frontierIO.writeBinary(parts.fragments)
  const sourceBytes = appendBarrelVariants(canonical, libraryBytes)
  const nativeBytes = appendBarrelVariants(native, libraryBytes, hash(sourceBytes))
  const outputs = [
    ['barrel-parts.glb', libraryBytes],
    ['barrel-fragments.glb', fragmentBytes],
    ['frontier-canonical.glb', sourceBytes],
    ['frontier-native.glb', nativeBytes],
    ['frontier.json', barrelMetadata(metadata, canonicalHash, hash(sourceBytes))],
  ] as const
  // Refuse to overwrite any previous attempt. Every failed stage remains inspectable.
  await mkdir(output)
  for (const [name, bytes] of outputs) {
    await writeFile(join(output, name), bytes, { flag: 'wx' })
  }
  const receipt = {
    inputs,
    source: {
      canonical: { path: options.canonical, sha256: canonicalHash },
      native: { path: options.native, sha256: hash(native) },
      metadata: {
        path: metadataPath,
        sha256: hash(metadata),
        fields: JSON.parse(metadata.toString('utf8')) as Record<string, unknown>,
      },
    },
    outputs: outputs.map(([name, bytes]) => ({
      path: join(output, name),
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
    owners: recipe.props.map(({ id, root }) => ({ id, root })),
    sourceHash: hash(sourceBytes),
    nativeSourceHash: readMountGlb(nativeBytes).json.extras?.frontierSourceHash,
  }
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  })
  return receipt
}
if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      canonical: { type: 'string' },
      native: { type: 'string' },
      metadata: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
  })
  if (!(values.canonical && values.native && values.output)) {
    throw new Error('Required: --canonical PATH --native PATH --output ABSOLUTE_NEW_DIRECTORY')
  }
  console.log(
    JSON.stringify(
      await stageBarrels({
        canonical: values.canonical,
        native: values.native,
        ...(values.metadata ? { metadata: values.metadata } : {}),
        output: values.output,
      }),
    ),
  )
}
