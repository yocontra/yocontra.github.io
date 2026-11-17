import { expect, test as it } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Document, NodeIO } from '@gltf-transform/core'
import { unpartition } from '@gltf-transform/functions'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'
import { installBarrelParts } from '../../tools/content/barrel-install.ts'
import { barrelMetadata, stageBarrels } from '../../tools/content/barrels.ts'

const next = 'b'.repeat(64)
it('actual Frontier metadata changes only its sourceHash, preserving all other parsed fields and bytes', async () => {
  const original = await readFile('tools/art/environments/frontier.json')
  const parsed = JSON.parse(original.toString()) as Record<string, unknown>
  if (typeof parsed.sourceHash !== 'string') {
    throw new Error('Invalid actual metadata')
  }
  const result = barrelMetadata(original, parsed.sourceHash, next)
  expect(Buffer.from(result).toString()).toBe(original.toString().replace(parsed.sourceHash, next))
  expect(JSON.parse(Buffer.from(result).toString())).toEqual({ ...parsed, sourceHash: next })
  expect(Buffer.from(barrelMetadata(result, next, parsed.sourceHash))).toEqual(original)
})
it('retains nonowned Unicode, numeric spellings, whitespace, arrays and escaped strings without reserialization', () => {
  const previous = 'a'.repeat(64)
  const text = ` {\n\t"sourceHash" : "${previous}", "life": {"name":"José \\u1234", "zero":-0.0, "number":1e-9}, "rows":[1, 2,3.1400], "empty":null, "flag":false }\r\n`
  const original = Buffer.from(text)
  expect(Buffer.from(barrelMetadata(original, previous, next)).toString()).toBe(
    text.replace(previous, next),
  )
  expect(original.toString()).toBe(text)
})
it('rejects an input metadata/canonical mismatch rather than updating a stale transaction', async () => {
  const bytes = await readFile('tools/art/environments/frontier.json')
  expect(() => barrelMetadata(bytes, 'a'.repeat(64), next)).toThrow(
    'does not match input canonical',
  )
})
it('rejects ambiguous duplicate/nested sourceHash tokens instead of changing a nonowned field', () => {
  const previous = 'a'.repeat(64)
  for (const text of [
    `{"sourceHash":"${previous}","sourceHash":"${previous}"}`,
    `{"sourceHash":null,"sourceHash":"${previous}"}`,
    `{"sourceHash":"${previous}","other":{"sourceHash":"${previous}"}}`,
  ]) {
    expect(() => barrelMetadata(Buffer.from(text), previous, next)).toThrow('Ambiguous')
  }
})
it('rejects malformed metadata and invalid canonical digests', () => {
  for (const text of ['null', '[]', 'false']) {
    expect(() => barrelMetadata(Buffer.from(text), next, next)).toThrow('Invalid Frontier metadata')
  }
  expect(() => barrelMetadata(Buffer.from('{'), next, next)).toThrow()
  expect(() => barrelMetadata(Buffer.from('{}'), 'invalid', next)).toThrow(
    'Invalid canonical SHA256',
  )
})

it('the real producer rejects mismatched metadata before creating any staging output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'out-west-barrel-metadata-'))
  const output = join(directory, 'stage')
  const metadataPath = 'tools/art/environments/frontier.json'
  const original = await readFile(metadataPath)
  try {
    const wrong = join(directory, 'wrong.json')
    await writeFile(
      wrong,
      JSON.stringify({ ...JSON.parse(original.toString()), sourceHash: 'a'.repeat(64) }),
    )
    await expect(
      stageBarrels({
        canonical: 'tools/art/environments/frontier.glb',
        native: 'public/experiments/out-west/3d/native-v2/baked/frontier.glb',
        metadata: wrong,
        output,
      }),
    ).rejects.toThrow('does not match input canonical')
    await expect(stat(output)).rejects.toThrow('ENOENT')
    expect(await readFile(metadataPath)).toEqual(original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('portable prefabs remain valid through the normal authoring installer after the metadata transaction', async () => {
  const io = new NodeIO()
  const stage = process.env.OW_BARREL_STAGE
  const library = await io.read(
    stage ? join(stage, 'barrel-parts.glb') : 'tools/art/environments/barrel-parts.glb',
  )
  const inputs = library.getRoot().getExtras().sourceInputs as { path: string; sha256: string }[]
  expect(inputs.length).toBeGreaterThan(0)
  expect(inputs.some((input) => input.path.endsWith('/frontier.json'))).toBe(false)
  const directory = await mkdtemp(join(tmpdir(), 'out-west-barrel-installed-'))
  try {
    const original = await readFile('tools/art/environments/frontier.json')
    const oldHash = (JSON.parse(original.toString()) as { sourceHash: string }).sourceHash
    const fixtureMetadata = join(directory, 'frontier.json')
    await writeFile(fixtureMetadata, original)
    await writeFile(fixtureMetadata, barrelMetadata(original, oldHash, next))
    expect(JSON.parse(await readFile(fixtureMetadata, 'utf8')).sourceHash).toBe(next)
    const doc = new Document()
    const buffer = doc.createBuffer()
    const scene = doc.createScene()
    const kit = doc.createMaterial('Kit')
    const primitive = doc
      .createPrimitive()
      .setMaterial(kit)
      .setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setBuffer(buffer)
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])),
      )
      .setIndices(
        doc
          .createAccessor()
          .setBuffer(buffer)
          .setType('SCALAR')
          .setArray(new Uint16Array([0, 1, 2])),
      )
    const placeholder = doc.createMesh('Legal source placeholder').addPrimitive(primitive)
    for (const prop of ENVIRONMENT_PROPS) {
      scene.addChild(
        doc.createNode(prop.root).addChild(doc.createNode('model').setMesh(placeholder)),
      )
    }
    // This is the real future frontier-authoring hook, including actual stable source-input hashes.
    await expect(installBarrelParts(doc, library)).resolves.toBeUndefined()
    const installed = scene.listChildren().map((owner) => owner.listChildren()[0]?.getMesh())
    expect(installed).toHaveLength(8)
    expect(new Set(installed).size).toBe(1)
    expect(
      installed.every((mesh) => mesh?.listPrimitives().every((part) => part.getMaterial() === kit)),
    ).toBe(true)
    // The normal frontier-authoring path unpartitions merged documents before its GLB write.
    await doc.transform(unpartition())
    expect((await io.writeBinary(doc)).length).toBeGreaterThan(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
