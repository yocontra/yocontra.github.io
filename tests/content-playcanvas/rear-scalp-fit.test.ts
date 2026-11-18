import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import type { Range } from '../../tools/content/character-atlas.ts'
import { fitRearScalpHair } from '../../tools/content/rear-scalp-fit.ts'

const io = new NodeIO()
for (const id of ['player', 'outlaw-6', 'outlaw-15', 'outlaw-16']) {
  it(`${id} seats the rear hair beyond the scalp with no skin or rig edits`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    const body = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === 'Character' && node.getSkin())
    const primitive = body?.getMesh()?.listPrimitives()[0]
    const position = primitive?.getAttribute('POSITION')
    const ranges = body?.getExtras().pieceRanges as Range[] | undefined
    const hair = ranges?.find(({ slot }) => slot === 'hair')
    const head = body
      ?.getSkin()
      ?.listJoints()
      .find((joint) => joint.getName() === 'Head')
    if (!(position && hair && head)) {
      throw new Error('Missing canonical hair fixture')
    }
    const origin = head.getWorldMatrix()
    const samples = Array.from({ length: position.getCount() }, (_, i) =>
      position.getElement(i, []),
    )
    const attributes = primitive
      ?.listAttributes()
      .filter((attribute) => attribute !== position)
      .map((attribute) => ({
        attribute,
        before: attribute.getArray()?.slice() ?? null,
      }))
    fitRearScalpHair(doc)
    const changed = samples.flatMap((old, i) => {
      const next = position.getElement(i, [])
      return old.some((point, axis) => next[axis] !== point) ? [{ old, next, i }] : []
    })
    expect(changed.length).toBeGreaterThan(25)
    for (const { old, next, i } of changed) {
      expect(i).toBeGreaterThanOrEqual(hair.start)
      expect(i).toBeLessThan(hair.start + hair.count)
      expect(next.slice(0, 2)).toEqual(old.slice(0, 2))
      expect((old[2] ?? 0) - origin[14]).toBeLessThan(-0.025)
      expect((old[2] ?? 0) - (next[2] ?? 0)).toBeGreaterThan(0)
      expect((old[2] ?? 0) - (next[2] ?? 0)).toBeLessThan(0.0042)
    }
    for (const { attribute, before } of attributes ?? []) {
      expect(attribute.getArray()).toEqual(before)
    }
  })
}
