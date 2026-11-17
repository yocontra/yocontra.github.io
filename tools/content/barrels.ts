/** Explicit offline staging only; publication remains the normal reviewed content transaction. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
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
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export async function stageBarrels(options: { canonical: string; native: string; output: string }) {
  const output = resolve(options.output)
  if (!isAbsolute(options.output) || output.startsWith(`${resolve('.')}${sep}`)) {
    throw new Error('Use a new absolute staging directory outside the checkout')
  }
  const canonical = await readFile(options.canonical)
  const native = await readFile(options.native)
  if (hash(canonical) !== recipe.sourceCanonicalSha256) {
    throw new Error('Rebase authored barrel bindings before changing the canonical input')
  }
  if (readMountGlb(native).json.extras?.frontierSourceHash !== hash(canonical)) {
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
      bindingCanonicalSha256: hash(canonical),
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
  ] as const
  // Refuse to overwrite any previous attempt. Every failed stage remains inspectable.
  await mkdir(output)
  for (const [name, bytes] of outputs) {
    await writeFile(join(output, name), bytes, { flag: 'wx' })
  }
  const receipt = {
    inputs,
    source: {
      canonical: { path: options.canonical, sha256: hash(canonical) },
      native: { path: options.native, sha256: hash(native) },
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
        output: values.output,
      }),
    ),
  )
}
