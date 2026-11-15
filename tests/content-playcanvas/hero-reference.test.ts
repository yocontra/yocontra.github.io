import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import { prepareHeroReference } from '../../tools/content/hero-reference.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const directory = 'tools/art/characters/hero'
const REVISION = /^[a-f0-9]{40}$/u

function animationData(doc: Document) {
  return doc
    .getRoot()
    .listAnimations()
    .map((clip) => ({
      name: clip.getName(),
      channels: clip.listChannels().map((channel) => ({
        node: channel.getTargetNode()?.getName(),
        path: channel.getTargetPath(),
        interpolation: channel.getSampler()?.getInterpolation(),
        times: Array.from(channel.getSampler()?.getInput()?.getArray() ?? []),
        values: Array.from(channel.getSampler()?.getOutput()?.getArray() ?? []),
      })),
    }))
}

it('human source is reproducible from pinned CC0 graphics and keeps the native joint contract', async () => {
  const [source, anatomy, eyes] = await Promise.all([
    io.read('tools/art/characters/player.gltf'),
    io.read(`${directory}/hero-skin-reference.glb`),
    io.read(`${directory}/hero-eyes-reference.glb`),
  ])
  await Promise.all([validateAuthoringInputs(anatomy), validateAuthoringInputs(eyes)])
  const provenance = JSON.parse(await readFile(`${directory}/cc0/provenance.json`, 'utf8'))
  expect(provenance.repositoryRevision).toMatch(REVISION)
  for (const file of provenance.files) {
    expect(['CC0-1.0', 'upstream license text']).toContain(file.license)
  }
  expect(anatomy.getRoot().getExtras().jointNames).toEqual(
    source
      .getRoot()
      .listSkins()[0]
      ?.listJoints()
      .map((joint) => joint.getName()),
  )
  const image = anatomy.getRoot().listTextures()[0]
  expect(image?.getSize()).toEqual([2048, 2048])
  expect(eyes.getRoot().listMeshes().length).toBeGreaterThanOrEqual(2)
})

it('anatomical surfaces have finite smooth normals and bounded normalized native weights', async () => {
  const anatomy = await io.read(`${directory}/hero-skin-reference.glb`)
  const primitive = anatomy.getRoot().listMeshes()[0]?.listPrimitives()[0]
  const position = primitive?.getAttribute('POSITION')
  const normal = primitive?.getAttribute('NORMAL')
  const joints = primitive?.getAttribute('_AUTHOR_JOINTS')
  const weights = primitive?.getAttribute('_AUTHOR_WEIGHTS')
  if (!(position && normal && joints && weights)) {
    throw new Error('Missing anatomical skin streams')
  }
  let minimumSum = Number.POSITIVE_INFINITY
  let maximumSum = Number.NEGATIVE_INFINITY
  let maximumNormalError = 0
  let finite = true
  let maximumWidth = 0
  let minimumHeight = Number.POSITIVE_INFINITY
  let maximumHeight = Number.NEGATIVE_INFINITY
  const used = new Set<number>()
  for (let i = 0; i < position.getCount(); i++) {
    const p = position.getElement(i, [])
    finite &&= p.every(Number.isFinite)
    maximumWidth = Math.max(maximumWidth, Math.abs(p[0] ?? 0))
    minimumHeight = Math.min(minimumHeight, p[1] ?? 0)
    maximumHeight = Math.max(maximumHeight, p[1] ?? 0)
    const w = weights.getElement(i, [])
    const sum = w.reduce((a, b) => a + b, 0)
    minimumSum = Math.min(minimumSum, sum)
    maximumSum = Math.max(maximumSum, sum)
    maximumNormalError = Math.max(
      maximumNormalError,
      Math.abs(Math.hypot(...normal.getElement(i, [])) - 1),
    )
    for (const [index, joint] of joints.getElement(i, []).entries()) {
      if ((w[index] ?? 0) > 0) {
        used.add(joint)
      }
    }
  }
  expect(minimumSum).toBeGreaterThan(0.999_99)
  expect(maximumSum).toBeLessThan(1.000_01)
  expect(maximumNormalError).toBeLessThan(0.000_01)
  expect(finite).toBe(true)
  expect(maximumWidth).toBeLessThan(0.6)
  expect(minimumHeight).toBeGreaterThan(0.6)
  expect(maximumHeight).toBeLessThan(1.85)
  const names = anatomy.getRoot().getExtras().jointNames as string[]
  for (const name of ['Head', 'Neck', 'WristL', 'WristR', 'Thumb1L', 'Index3R']) {
    expect(used.has(names.indexOf(name))).toBe(true)
  }
})

it('hero fitting replaces exposed anatomy while preserving all animation channels, skin and equipment', async () => {
  const doc = await io.read('tools/art/characters/player.gltf')
  const before = animationData(doc)
  const skins = doc
    .getRoot()
    .listSkins()
    .map((skin) => ({
      joints: skin.listJoints(),
      inverse: Array.from(skin.getInverseBindMatrices()?.getArray() ?? []),
    }))
  const meshes = doc.getRoot().listMeshes()
  const wardrobe = meshes
    .flatMap((mesh) => mesh.listPrimitives())
    .map((primitive) => ({
      primitive,
      positions: primitive.getAttribute('POSITION')?.getArray()?.slice(),
      material: primitive.getMaterial(),
    }))
  await prepareHeroReference(doc)
  expect(animationData(doc)).toEqual(before)
  expect(
    doc
      .getRoot()
      .listSkins()
      .map((skin) => ({
        joints: skin.listJoints(),
        inverse: Array.from(skin.getInverseBindMatrices()?.getArray() ?? []),
      })),
  ).toEqual(skins)
  for (const original of wardrobe) {
    expect(original.primitive.getAttribute('POSITION')?.getArray()).toEqual(original.positions)
    expect(original.primitive.getMaterial()).toBe(original.material)
  }
  const material = doc
    .getRoot()
    .listMaterials()
    .find((candidate) => candidate.getName() === 'Hero anatomical skin reference')
  expect(material?.getBaseColorTexture()?.getSize()).toEqual([2048, 2048])
  expect(material?.getBaseColorTexture()?.getMimeType()).toBe('image/webp')
  expect(material?.getMetallicFactor()).toBe(0)
  expect(material?.getRoughnessFactor()).toBe(0.48)
  const anatomical = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .filter((primitive) => primitive.getMaterial() === material)
  expect(anatomical).toHaveLength(1)
  for (const primitive of anatomical) {
    expect(primitive.getAttribute('JOINTS_0')).toBeTruthy()
    expect(primitive.getAttribute('WEIGHTS_0')).toBeTruthy()
    expect(primitive.getAttribute('_AUTHOR_JOINTS')).toBeNull()
  }
})
