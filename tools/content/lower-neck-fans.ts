import type { Document, Primitive } from '@gltf-transform/core'
import type { Range } from './character-atlas.ts'

// The lower rim doubles back at these two source vertices. Remove each spike
// and turn the adjacent diagonal so the skin stays outward when the neck bends.
const FANS = [
  {
    spike: 152,
    before: [151, 147, 146, 151, 146, 152, 151, 152, 153],
    after: [151, 147, 153, 147, 146, 153],
  },
  {
    spike: 178,
    before: [177, 176, 178, 177, 178, 179, 177, 179, 6],
    after: [177, 176, 6, 176, 179, 6],
  },
] as const

function repairFans(primitive: Primitive): void {
  const indices = primitive.getIndices()
  const source = indices?.getArray()
  if (!(indices && source)) {
    return
  }
  const replacements = new Map<number, readonly number[]>()
  for (const { before, after, spike } of FANS) {
    let incidence = 0
    let start: number | undefined
    for (let offset = 0; offset < source.length; offset += 3) {
      if (
        source[offset] === spike ||
        source[offset + 1] === spike ||
        source[offset + 2] === spike
      ) {
        incidence++
      }
      if (before.every((vertex, corner) => source[offset + corner] === vertex)) {
        start = offset
      }
    }
    // Some open-neck garments already remove this rim and keep a larger cutout.
    if (incidence !== 2 || start === undefined) {
      continue
    }
    replacements.set(start, after)
    replacements.set(start + 3, [])
    replacements.set(start + 6, [])
  }
  if (replacements.size === 0) {
    return
  }
  const repaired: number[] = []
  for (let offset = 0; offset < source.length; offset += 3) {
    repaired.push(...(replacements.get(offset) ?? source.subarray(offset, offset + 3)))
  }
  primitive.setIndices(indices.clone().setArray(Uint32Array.from(repaired)))
}

/** Repair the two folded boundary fans on the shared male head topology. */
export function repairLowerNeckFans(doc: Document): void {
  for (const node of doc.getRoot().listNodes()) {
    if (node.getName() !== 'Character' || !node.getSkin()) {
      continue
    }
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const ranges = (primitive.getExtras().pieceRanges ?? node.getExtras().pieceRanges) as
        | Range[]
        | undefined
      const head = ranges?.[0]
      if (head?.slot === 'skin' && head.start === 0 && head.count === 1555) {
        repairFans(primitive)
      }
    }
  }
}
