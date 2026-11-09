import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { extractFirstPersonArms } from '../../tools/content/first-person-arms.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const ATTACHMENT = /^(?:mount\.|socket\.)/u
function vertex(primitive: Primitive, index: number): string {
  return JSON.stringify(
    primitive
      .listSemantics()
      .toSorted((a, b) => a.localeCompare(b))
      .map((semantic) => {
        const attribute = primitive.getAttribute(semantic)
        const width = attribute?.getElementSize() ?? 0
        return [
          semantic,
          attribute?.getComponentType(),
          attribute?.getNormalized(),
          Array.from(attribute?.getArray()?.slice(index * width, (index + 1) * width) ?? []),
        ]
      }),
  )
}
function triangles(primitive: Primitive): string[] {
  const indices = primitive.getIndices()
  if (!indices) {
    throw new Error('Expected indexed surface')
  }
  return Array.from({ length: indices.getCount() / 3 }, (_, face) =>
    JSON.stringify([0, 1, 2].map((c) => vertex(primitive, indices.getScalar(face * 3 + c)))),
  )
}
function clips(doc: Document): string {
  return JSON.stringify(
    doc
      .getRoot()
      .listAnimations()
      .filter((clip) => !clip.getName().startsWith('Weapon_'))
      .map((clip) => ({
        name: clip.getName(),
        extras: clip.getExtras(),
        channels: clip.listChannels().map((channel) => ({
          target: channel.getTargetNode()?.getName(),
          path: channel.getTargetPath(),
          interpolation: channel.getSampler()?.getInterpolation(),
          times: Array.from(channel.getSampler()?.getInput()?.getArray() ?? []),
          values: Array.from(channel.getSampler()?.getOutput()?.getArray() ?? []),
        })),
      })),
  )
}
for (const [id, faces, vertices] of [
  ['outfit.trail-duds', 2518, 1477],
  ['outfit.wool-duster', 2654, 1724],
] as const) {
  it(`${id} retains only complete fitted arm faces with exact native streams, skin, PBR and clocks`, async () => {
    const nativePath = `public/experiments/out-west/3d/native-v2/equipment/${id}.glb`
    const first = await extractFirstPersonArms(id)
    const second = await extractFirstPersonArms(id)
    expect(first.bytes).toEqual(second.bytes)
    expect(first.report).toEqual(second.report)
    const inputs = first.report.sourceInputs
    const categories =
      id === 'outfit.trail-duds'
        ? ['boot-bridges', 'waistcoats']
        : ['coat-sleeves', 'boot-bridges', 'coat-collars', 'shirt-fronts']
    const expectedInputs = [
      nativePath,
      `tools/art/characters/${id}.gltf`,
      `tools/art/characters/${id}.bin`,
      ...categories.map((category) => `tools/art/characters/${category}/${id}.glb`),
      ...[
        'first-person-arms.ts',
        'garment-parts.ts',
        'garment-geometry.ts',
        'waistcoat-fit.ts',
        'waistcoat-pattern.json',
        'authoring-inputs.ts',
      ].map((helper) => `tools/content/${helper}`),
    ]
    expect(inputs.map((entry) => entry.path)).toEqual(
      expectedInputs.toSorted((a, b) => a.localeCompare(b)),
    )
    await Promise.all(
      inputs.map(async (entry) => {
        expect(
          createHash('sha256')
            .update(await readFile(entry.path))
            .digest('hex'),
        ).toBe(entry.sha256)
      }),
    )
    expect(first.report.sourceFaces).toBe(faces)
    expect(first.report.retainedFaces).toBe(faces)
    expect(first.report.surfaces.reduce((sum, surface) => sum + surface.vertices, 0)).toBe(vertices)
    const output = await io.readBinary(first.bytes)
    const input = await io.read(nativePath)
    const beforeJson = (await io.readAsJSON(nativePath)).json
    const afterJson = (await io.binaryToJSON(first.bytes)).json
    for (const material of afterJson.materials ?? []) {
      // Compare the complete serialized material, including every PBR factor and external URL.
      const original = beforeJson.materials?.find((before) => before.name === material.name)
      if (!original) {
        throw new Error('Missing original serialized material')
      }
      expect(material).toEqual(original)
    }
    expect(clips(output)).toBe(clips(input))
    expect(
      output
        .getRoot()
        .listAnimations()
        .some((clip) => clip.getName().startsWith('Weapon_')),
    ).toBe(false)
    expect(
      output
        .getRoot()
        .listNodes()
        .some((node) => ATTACHMENT.test(node.getName())),
    ).toBe(false)
    expect(output.getRoot().listMaterials()).toHaveLength(2)
    const inputNodes = input.getRoot().listNodes()
    const originalTriangles = new Map<string, Set<string>>()
    for (const mesh of input.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        originalTriangles.set(
          primitive.getMaterial()?.getName() ?? '',
          new Set(triangles(primitive)),
        )
      }
    }
    let actual = 0
    for (const node of output.getRoot().listNodes()) {
      expect(
        inputNodes.some(
          (original) =>
            original.getName() === node.getName() &&
            JSON.stringify(original.getMatrix()) === JSON.stringify(node.getMatrix()) &&
            JSON.stringify(original.getTranslation()) === JSON.stringify(node.getTranslation()) &&
            JSON.stringify(original.getRotation()) === JSON.stringify(node.getRotation()) &&
            JSON.stringify(original.getScale()) === JSON.stringify(node.getScale()) &&
            original.getParentNode()?.getName() === node.getParentNode()?.getName(),
        ),
      ).toBe(true)
      const skin = node.getSkin()
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        expect(skin).toBeTruthy()
        const material = primitive.getMaterial()
        const before = input
          .getRoot()
          .listMaterials()
          .find((candidate) => candidate.getName() === material?.getName())
        if (!(material && before)) {
          throw new Error('Missing retained native material')
        }
        // Property.equals recursively compares PBR factors, texture data/URIs, samplers and extensions.
        expect(material.equals(before)).toBe(true)
        expect(material.getExtras().equipmentPart).toBeUndefined()
        for (const triangle of triangles(primitive)) {
          expect(originalTriangles.get(material?.getName() ?? '')?.has(triangle)).toBe(true)
          actual++
        }
      }
    }
    const skinData = (doc: Document) =>
      doc
        .getRoot()
        .listSkins()
        .filter((skin) => skin.listJoints().some((joint) => joint.getName() === 'WristR'))
        .map((skin) => ({
          joints: skin.listJoints().map((joint) => joint.getName()),
          skeleton: skin.getSkeleton()?.getName(),
          bind: Array.from(skin.getInverseBindMatrices()?.getArray() ?? []),
        }))
    expect(skinData(output)).toEqual(skinData(input))
    expect(actual).toBe(faces)
  })
}
