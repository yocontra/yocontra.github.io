import type { Document } from '@gltf-transform/core'
import { math } from 'playcanvas'
import type { Range } from './character-atlas.ts'

type Point = [number, number, number]

/** Seat the rear hair shell outside the scalp without changing the hairline or the skin. */
export function fitRearScalpHair(doc: Document): void {
  for (const node of doc.getRoot().listNodes()) {
    const head = node
      .getSkin()
      ?.listJoints()
      .find((joint) => joint.getName() === 'Head')
    const mesh = node.getMesh()
    if (!(head && mesh && node.getName() === 'Character')) {
      continue
    }
    const origin = head.getWorldMatrix().slice(12, 15) as Point
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')
      const ranges = (primitive.getExtras().pieceRanges ??
        node.getExtras().pieceRanges ??
        []) as Range[]
      const skull = ranges.find(({ slot }) => slot === 'skin')
      const hair = ranges.find(({ slot }) => slot === 'hair')
      if (!(position && skull && hair)) {
        continue
      }
      let crown = 0
      for (let index = skull.start; index < skull.start + skull.count; index++) {
        crown = Math.max(crown, (position.getElement(index, [])[1] ?? 0) - origin[1])
      }
      if (crown < 0.1) {
        continue
      }
      const scale = crown / 0.199_726_505_927_274_6
      for (let index = hair.start; index < hair.start + hair.count; index++) {
        const point = position.getElement(index, [0, 0, 0]) as Point
        const [x, y, z] = point
        const height = (y - origin[1]) / scale
        const rear = (origin[2] - z) / scale
        const lateral = Math.abs(x - origin[0]) / scale
        // Fade the clearance toward the crown, behind the ears, and at the nape hairline.
        const weight =
          math.smoothstep(0.082, 0.103, height) *
          (1 - math.smoothstep(0.168, 0.199, height)) *
          math.smoothstep(0.027, 0.043, rear) *
          (1 - math.smoothstep(0.045, 0.064, lateral))
        if (weight > 0) {
          point[2] = z - scale * weight * 0.0036
          position.setElement(index, point)
        }
      }
    }
  }
}
