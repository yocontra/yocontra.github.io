import source from '../content/collision.json' with { type: 'json' }
import type { CollisionData } from './protocol.ts'

function tuple(values: readonly number[]): [number, number, number] {
  const [x, y, z] = values
  if (
    values.length !== 3 ||
    x === undefined ||
    y === undefined ||
    z === undefined ||
    ![x, y, z].every(Number.isFinite)
  ) {
    throw new Error('Invalid collision vector')
  }
  return [x, y, z]
}
/** The build artifact is validated once; each physics world owns its native collision shapes. */
export const COLLISION: CollisionData = {
  ...source,
  boxes: source.boxes.map((box) => ({
    ...box,
    center: tuple(box.center),
    halfExtents: tuple(box.halfExtents),
  })),
}
