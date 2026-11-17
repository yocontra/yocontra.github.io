import { expect, test as it } from 'bun:test'
import {
  type Accessor,
  type Document,
  NodeIO,
  type Primitive,
  type Skin,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { repairHeadNape } from '../../tools/content/head-nape.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const values = (accessor: Accessor | null) => Array.from(accessor?.getArray() ?? [])
function invariant(doc: Document, primitive: Primitive, skin: Skin): string {
  return JSON.stringify({
    attributes: ['TEXCOORD_0', 'TEXCOORD_1', 'JOINTS_0', 'WEIGHTS_0'].map((name) => [
      name,
      values(primitive.getAttribute(name)),
    ]),
    indices: values(primitive.getIndices()),
    bind: values(skin.getInverseBindMatrices()),
    rig: skin
      .listJoints()
      .map((n) => [n.getName(), n.getTranslation(), n.getRotation(), n.getScale()]),
    clips: doc
      .getRoot()
      .listAnimations()
      .map((a) => [
        a.getName(),
        a.listChannels().map((c) => [c.getTargetNode()?.getName(), c.getTargetPath()]),
        a
          .listSamplers()
          .map((s) => [s.getInterpolation(), values(s.getInput()), values(s.getOutput())]),
      ]),
  })
}
for (const id of ['player', 'outfit.trail-duds', 'outfit.wool-duster', 'outlaw-0', 'outlaw-8']) {
  it(`${id} preserves neck length and collar attachment while joining the nape continuously to the skull`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    const node = doc
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === 'Character' && n.getSkin() && n.getExtras().pieceRanges)
    const primitive = node?.getMesh()?.listPrimitives()[0]
    const position = primitive?.getAttribute('POSITION')
    const skin = node?.getSkin()
    const head = skin?.listJoints().find((n) => n.getName() === 'Head')
    const range = (
      (node?.getExtras().pieceRanges ?? []) as { start: number; count: number; slot: string }[]
    )[0]
    if (!(primitive && position && skin && head && range)) {
      throw new Error('Missing canonical neck fixture')
    }
    const [headX = 0, headY = 0, headZ = 0] = head.getWorldMatrix().slice(12, 15)
    expect(range.slot).toBe('skin')
    const allBefore = values(position)
    const normalsBefore = values(primitive.getAttribute('NORMAL'))
    const before = Array.from({ length: range.count }, (_, i) =>
      position.getElement(range.start + i, []),
    )
    const unchanged = invariant(doc, primitive, skin)
    expect(await repairHeadNape(doc)).toBe(true)
    expect(invariant(doc, primitive, skin)).toBe(unchanged)
    const allAfter = values(position)
    const normalsAfter = values(primitive.getAttribute('NORMAL'))
    expect(allAfter.every(Number.isFinite)).toBe(true)
    expect(normalsAfter.every(Number.isFinite)).toBe(true)
    expect(normalsAfter.slice((range.start + range.count) * 3)).toEqual(
      normalsBefore.slice((range.start + range.count) * 3),
    )
    expect(allAfter.slice(0, range.start * 3)).toEqual(allBefore.slice(0, range.start * 3))
    expect(allAfter.slice((range.start + range.count) * 3)).toEqual(
      allBefore.slice((range.start + range.count) * 3),
    )
    const rows = before.map((old, i) => ({ old, next: position.getElement(range.start + i, []) }))
    expect(rows.map(({ next }) => next[1])).toEqual(before.map((old) => old[1]))
    const dx = rows.map(({ old, next }) => (next[0] ?? 0) - (old[0] ?? 0))
    expect(Math.min(...dx)).toBeLessThan(-0.001)
    expect(Math.max(...dx)).toBeGreaterThan(0.001)
    const collar = rows.filter(
      ({ old }) => (old[1] ?? 0) >= headY - 0.14 && (old[1] ?? 0) <= headY - 0.06,
    )
    expect(collar.length).toBeGreaterThan(20)
    expect(collar.map(({ next }) => next)).toEqual(collar.map(({ old }) => old))
    const nape = rows.filter(
      ({ old }) =>
        (old[1] ?? 0) > headY - 0.04 &&
        (old[1] ?? 0) <= headY + 0.006 &&
        (old[2] ?? 0) < headZ - 0.025,
    )
    expect(nape.length).toBeGreaterThan(20)
    expect(Math.min(...nape.map(({ old, next }) => (next[2] ?? 0) - (old[2] ?? 0)))).toBeLessThan(
      -0.002,
    )
    const front = rows.filter(({ old }) => (old[2] ?? 0) >= headZ + 0.01)
    expect(front.map(({ next }) => next)).toEqual(front.map(({ old }) => old))
    const ears = rows.filter(({ old }) => Math.abs((old[0] ?? 0) - headX) > 0.075)
    expect(ears.length).toBeGreaterThan(0)
    expect(ears.map(({ next }) => next)).toEqual(ears.map(({ old }) => old))
    const hairRange = (
      (node?.getExtras().pieceRanges ?? []) as { start: number; count: number; slot: string }[]
    ).find((part) => part.slot === 'hair')
    if (!hairRange) {
      throw new Error('Missing fitted hair fixture')
    }
    const hairBack = Array.from({ length: hairRange.count }, (_, i) =>
      allBefore.slice((hairRange.start + i) * 3, (hairRange.start + i + 1) * 3),
    ).filter((p) => (p[2] ?? 0) < headZ - 0.025 && Math.abs((p[0] ?? 0) - headX) < 0.06)
    // Longer hairstyles reach the neck; protect the scalp cap rather than the whole hair length.
    const crown = Math.max(...before.map((p) => p[1] ?? 0)) - headY
    const coveredFrom = Math.max(
      headY + crown * 0.45,
      Math.min(...hairBack.map((p) => p[1] ?? 0)) + 0.025,
    )
    const coveredScalp = rows.filter(({ old }) => (old[1] ?? 0) >= coveredFrom)
    expect(coveredScalp.length).toBeGreaterThan(20)
    // The fitted hair is immutable: expanding the upper skull through it creates bald patches.
    expect(coveredScalp.map(({ next }) => next)).toEqual(coveredScalp.map(({ old }) => old))
    const dz = rows.map(({ old, next }) => (next[2] ?? 0) - (old[2] ?? 0))
    expect(Math.max(...dz)).toBeGreaterThan(0.004)
    const posterior = rows.filter(({ old }) => (old[2] ?? 0) < headZ - 0.035)
    expect(
      Math.max(...posterior.map(({ old, next }) => (next[2] ?? 0) - (old[2] ?? 0))),
    ).toBeGreaterThan(0.002)
  }, 30_000)
}
