import { expect, test as it } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Document, NodeIO } from '@gltf-transform/core'
import {
  CACTUS_MATERIAL,
  CACTUS_MESH,
  cactusHash,
  cactusMeshSignature,
  cactusRemainder,
  cactusStage,
  cactusTarget,
  freezeCactusFiles,
  replaceCactusPrototype,
  cactusRequired as required,
  verifyCactusFiles,
} from '../../tools/content/frontier-cactus-candidate.ts'

/** Real indexed GLBs with shared mesh/material ownership, not a mocked renderer. */
function fixture() {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const accessor = (type: 'VEC2' | 'VEC3' | 'SCALAR', array: Float32Array | Uint16Array) =>
    doc.createAccessor().setType(type).setArray(array.slice()).setBuffer(buffer)
  const pixels = Buffer.from(
    // biome-ignore lint/security/noSecrets: One-pixel PNG fixture bytes, not a credential.
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC6kAAAAASUVORK5CYII=',
    'base64',
  )
  const texture = doc.createTexture('Original scan').setImage(pixels).setMimeType('image/png')
  const material = doc
    .createMaterial('Original shared skin')
    .setMetallicFactor(0)
    .setBaseColorTexture(texture)
    .setNormalTexture(texture)
    .setMetallicRoughnessTexture(texture)
    .setOcclusionTexture(texture)
  const primitive = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute(
      'POSITION',
      accessor(
        'VEC3',
        new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
      ),
    )
    .setAttribute('NORMAL', accessor('VEC3', new Float32Array(24).fill(0.577)))
    .setAttribute('COLOR_0', accessor('VEC3', new Float32Array(24).fill(0.5)))
    .setAttribute(
      'TEXCOORD_0',
      accessor('VEC2', new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1])),
    )
    .setIndices(
      accessor(
        'SCALAR',
        new Uint16Array([
          0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3,
          1, 2, 6, 1, 6, 5,
        ]),
      ),
    )
  const mesh = doc.createMesh(CACTUS_MESH).addPrimitive(primitive)
  const target = doc.createNode('prefab.saguaro_one_arm').setMesh(mesh).setTranslation([3, 0, 16])
  const other = doc
    .createNode('Other near, borrowed mesh')
    .setMesh(mesh)
    .setTranslation([20, 0, 20])
  const far = doc.createNode('Unchanged far').setMesh(mesh).setTranslation([40, 0, 40])
  doc.createScene('Main fixture').addChild(target).addChild(other).addChild(far)
  return doc
}
async function documents() {
  const io = new NodeIO()
  const bytes = await io.writeBinary(fixture())
  const [baseline, parts, source] = await Promise.all([
    io.readBinary(bytes),
    io.readBinary(bytes),
    io.readBinary(bytes),
  ])
  for (const doc of [parts, source]) {
    const [first, ...others] = doc.getRoot().listNodes()
    for (const node of others) {
      node.dispose()
    }
    required(first).setTranslation([0, 0, 0])
  }
  required(parts.getRoot().listMaterials()[0]).setName(CACTUS_MATERIAL)
  required(parts.getRoot().listTextures()[0]).setName('Cactus near fixture')
  return { baseline, parts, source, io }
}
it('round-trips one private prototype while preserving every other borrowed resource and transform', async () => {
  const { baseline, parts, source, io } = await documents()
  const originals = baseline
    .getRoot()
    .listNodes()
    .map((node) => ({
      name: node.getName(),
      matrix: node.getMatrix(),
      mesh: cactusMeshSignature(required(node.getMesh())),
    }))
  const material = required(baseline.getRoot().listMaterials()[0])
  const texture = required(baseline.getRoot().listTextures()[0])
  const pixels = required(texture.getImage()).slice()
  const remainder = cactusRemainder(baseline)
  const result = replaceCactusPrototype(baseline, parts, source)
  expect(result.replaced).toBe(1)
  expect(result.triangles).toBe(12)
  expect(result.densityRatio).toBe(1)
  expect(baseline.getRoot().listMaterials()[0]).toBe(material)
  expect(material.getName()).toBe('Original shared skin')
  expect(texture.getImage()).toEqual(pixels)
  const decoded = await io.readBinary(await io.writeBinary(baseline))
  expect(cactusRemainder(decoded)).toBe(remainder)
  const prototype = required(cactusTarget(decoded).getMesh())
  expect(required(required(prototype.listPrimitives()[0]).getMaterial()).getName()).toBe(
    CACTUS_MATERIAL,
  )
  expect(decoded.getRoot().listNodes()).toHaveLength(3)
  for (const old of originals) {
    const node = required(
      decoded
        .getRoot()
        .listNodes()
        .find((value) => value.getName() === old.name),
    )
    expect(node.getMatrix()).toEqual(old.matrix)
  }
  for (const old of originals.filter((entry) => entry.name !== 'prefab.saguaro_one_arm')) {
    const node = required(
      decoded
        .getRoot()
        .listNodes()
        .find((value) => value.getName() === old.name),
    )
    expect(cactusMeshSignature(required(node.getMesh()))).toBe(old.mesh)
    expect(node.getMesh()).not.toBe(prototype)
  }
})
it('rejects a changed physical UV recipe even when pivot and bounds match', async () => {
  const { baseline, parts, source } = await documents()
  const uv = required(
    required(required(parts.getRoot().listMeshes()[0]).listPrimitives()[0]).getAttribute(
      'TEXCOORD_0',
    ),
  )
  for (let i = 0; i < uv.getCount(); i++) {
    uv.setElement(
      i,
      uv.getElement(i, []).map((v) => v * 2),
    )
  }
  expect(() => replaceCactusPrototype(baseline, parts, source)).toThrow('physical UV density')
})
it('rejects a changed donor envelope', async () => {
  const { baseline, parts, source } = await documents()
  required(parts.getRoot().listNodes()[0]).setTranslation([0.05, 0, 0])
  expect(() => replaceCactusPrototype(baseline, parts, source)).toThrow('envelope')
})
for (const [delta, accepted] of [
  [0.002, true],
  [0.08, false],
] as const) {
  it(`keeps the explicit4cm decorative world envelope limit with local bounds/TRS intact (${delta})`, async () => {
    const { baseline, parts, source } = await documents()
    const target = cactusTarget(baseline)
    target.setRotation([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)])
    target.setTranslation([3.5 - Math.SQRT1_2, 0, 16.5])
    const matrix = target.getMatrix()
    const positions = required(
      required(required(parts.getRoot().listMeshes()[0]).listPrimitives()[0]).getAttribute(
        'POSITION',
      ),
    )
    positions.setElement(0, [delta, 0, 0])
    positions.setElement(3, [delta, 1, 0])
    let error: string | null = null
    let measured = Number.POSITIVE_INFINITY
    try {
      measured = replaceCactusPrototype(baseline, parts, source).worldEnvelopeMaxErrorM
    } catch (failure) {
      error = String(failure)
    }
    expect(error === null).toBe(accepted)
    expect(measured <= 0.04).toBe(accepted)
    expect(target.getMatrix()).toEqual(matrix)
  })
}
it('enforces the near triangle ceiling independently of matching envelope and density', async () => {
  const { baseline, parts, source } = await documents()
  const primitive = required(required(parts.getRoot().listMeshes()[0]).listPrimitives()[0])
  const indices = Array.from(required(required(primitive.getIndices()).getArray()))
  const repeated = Array.from({ length: 1667 }, () => indices).flat()
  primitive.setIndices(
    parts
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint16Array(repeated))
      .setBuffer(required(parts.getRoot().listBuffers()[0])),
  )
  expect(() => replaceCactusPrototype(baseline, parts, source)).toThrow('triangle budget')
})
it('refuses a candidate that lost its genuine occlusion map', async () => {
  const { baseline, parts, source } = await documents()
  required(parts.getRoot().listMaterials()[0]).setOcclusionTexture(null)
  expect(() => replaceCactusPrototype(baseline, parts, source)).toThrow('all native PBR maps')
})
it('refuses ambiguous yard matching rather than replacing every shared instance', async () => {
  const { baseline, parts, source } = await documents()
  const target = cactusTarget(baseline)
  required(baseline.getRoot().listScenes()[0]).addChild(
    baseline
      .createNode('Duplicate yard')
      .setMesh(target.getMesh())
      .setTranslation(target.getTranslation()),
  )
  expect(() => replaceCactusPrototype(baseline, parts, source)).toThrow('found 2')
})
it('detects changed actual source, map, script and output bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cactus-inputs-'))
  try {
    await Promise.all(
      ['source.glb', 'map.png', 'author.py', 'near.glb'].map(async (name) => {
        const path = join(directory, name)
        await writeFile(path, 'frozen')
        const records = [{ path, sha256: cactusHash(await readFile(path)) }]
        await verifyCactusFiles(records)
        const immutable = await freezeCactusFiles(records)
        await writeFile(path, 'stale')
        expect(immutable.get(path)?.toString()).toBe('frozen')
        await expect(verifyCactusFiles(records)).rejects.toThrow('Changed cactus input')
        await expect(freezeCactusFiles(records)).rejects.toThrow('Changed cactus input')
      }),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('rejects checkout output and symlink aliases before creating producer directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cactus-paths-'))
  try {
    await expect(cactusStage(join(process.cwd(), 'public'))).rejects.toThrow('outside')
    await symlink(process.cwd(), join(directory, 'alias'))
    await expect(cactusStage(join(directory, 'alias', 'must-not-create'))).rejects.toThrow(
      'outside',
    )
    expect(await cactusStage(directory)).toBe(await realpath(directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('projects cloud UV1 from the rotated, moved, scaled target while retaining UV0 and borrowed meshes', async () => {
  const { baseline, parts, source } = await documents()
  const target = cactusTarget(baseline)
  target.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2])
  target.setScale([2, 1, 1])
  target.setTranslation([3, 0, 17.5])
  const originalMesh = required(target.getMesh())
  const originalUV0 = required(
    required(originalMesh.listPrimitives()[0]).getAttribute('TEXCOORD_0'),
  ).getArray()
  const result = replaceCactusPrototype(baseline, parts, source)
  const primitive = required(required(target.getMesh()).listPrimitives()[0])
  const uv = required(primitive.getAttribute('TEXCOORD_1'))
  expect(result.replaced).toBe(1)
  expect(uv.getElement(0, [])[0]).toBeCloseTo(3 / 1024, 8)
  expect(uv.getElement(0, [])[1]).toBeCloseTo(17.5 / 1024, 8)
  expect(uv.getElement(1, [])[0]).toBeCloseTo(3 / 1024, 8)
  expect(uv.getElement(1, [])[1]).toBeCloseTo(15.5 / 1024, 8)
  expect(required(primitive.getAttribute('TEXCOORD_0')).getArray()).toEqual(originalUV0)
  expect(required(originalMesh.listPrimitives()[0]).getAttribute('TEXCOORD_1')).toBeNull()
})
