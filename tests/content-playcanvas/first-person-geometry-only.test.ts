import { expect, test as it } from 'bun:test'
import { type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { extractFirstPersonArms } from '../../tools/content/first-person-arms.ts'
import { hangTimeout } from '../timeout.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
function geometry(doc: Document) {
  return doc
    .getRoot()
    .listNodes()
    .map((node) => ({
      name: node.getName(),
      parent: node.getParentNode()?.getName(),
      transform: Array.from(node.getMatrix()),
      skin: node.getSkin() && {
        joints: node
          .getSkin()
          ?.listJoints()
          .map((joint) => joint.getName()),
        bind: Array.from(node.getSkin()?.getInverseBindMatrices()?.getArray() ?? []),
      },
      primitives: node
        .getMesh()
        ?.listPrimitives()
        .map((primitive) => ({
          material: primitive.getMaterial()?.getName(),
          indices: Array.from(primitive.getIndices()?.getArray() ?? []),
          attributes: primitive.listSemantics().map((semantic) => {
            const attribute = primitive.getAttribute(semantic)
            return [
              semantic,
              attribute?.getType(),
              attribute?.getComponentType(),
              attribute?.getNormalized(),
              Array.from(attribute?.getArray() ?? []),
            ]
          }),
        })),
    }))
}
for (const id of ['outfit.trail-duds', 'outfit.wool-duster']) {
  it(
    `${id} geometry-only strips all clip payload while retaining fitted native geometry/skin/PBR`,
    async () => {
      const normal = await extractFirstPersonArms(id)
      const stripped = await extractFirstPersonArms(id, { geometryOnly: true })
      const body = await io.readBinary(normal.bytes)
      const arms = await io.readBinary(stripped.bytes)
      expect(body.getRoot().listAnimations()).toHaveLength(12)
      expect(normal.report.animationMode).toBe('local-clips')
      expect(stripped.report.animationMode).toBe('geometry-only')
      expect(arms.getRoot().getExtras().firstPersonArms).toMatchObject({
        animationMode: 'geometry-only',
      })
      expect(arms.getRoot().listAnimations()).toHaveLength(0)
      expect(geometry(arms)).toEqual(geometry(body))
      expect(stripped.report.surfaces).toEqual(normal.report.surfaces)
      expect(stripped.report.sourceFaces).toBe(normal.report.sourceFaces)
      expect(stripped.report.retainedFaces).toBe(normal.report.retainedFaces)
      for (const material of arms.getRoot().listMaterials()) {
        const original = body
          .getRoot()
          .listMaterials()
          .find((entry) => entry.getName() === material.getName())
        if (!original) {
          throw new Error('Retained material missing')
        }
        expect(material.equals(original)).toBe(true)
      }
      const used = new Set(
        arms
          .getRoot()
          .listSkins()
          .flatMap((skin) => {
            const bind = skin.getInverseBindMatrices()
            return bind ? [bind] : []
          }),
      )
      for (const mesh of arms.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const index = primitive.getIndices()
          if (index) {
            used.add(index)
          }
          for (const semantic of primitive.listSemantics()) {
            const attribute = primitive.getAttribute(semantic)
            if (attribute) {
              used.add(attribute)
            }
          }
        }
      }
      expect(
        arms
          .getRoot()
          .listAccessors()
          .every((accessor) => used.has(accessor)),
      ).toBe(true)
      expect(arms.getRoot().listAccessors()).toHaveLength(used.size)
      const { json } = await io.binaryToJSON(stripped.bytes)
      expect(json.animations ?? []).toHaveLength(0)
      expect(json.images ?? []).toHaveLength(0)
      expect(stripped.bytes.length).toBeLessThan(normal.bytes.length / 2)
      expect(stripped.report.sourceInputs).toEqual(normal.report.sourceInputs)
    },
    hangTimeout(30_000),
  )
}
