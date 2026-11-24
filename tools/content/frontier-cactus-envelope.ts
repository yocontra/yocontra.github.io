import type { Node } from '@gltf-transform/core'
import { getBounds } from '@gltf-transform/functions'

type Bounds = ReturnType<typeof getBounds>
const axes = [0, 1, 2] as const

export function cactusEnvelopeError(before: Bounds, after: Bounds): number {
  return Math.max(
    ...axes.map((axis) =>
      Math.max(
        Math.abs(after.min[axis] - before.min[axis]),
        Math.abs(after.max[axis] - before.max[axis]),
      ),
    ),
  )
}

/** Compare each planted silhouette in donor metres along its viewing axis. */
export function verifyPlantedCactusEnvelope(node: Node, before: Bounds) {
  const after = getBounds(node)
  const matrix = node.getWorldMatrix()
  const basis = [
    [0, 4, 8],
    [1, 5, 9],
    [2, 6, 10],
  ] as const
  const worldEnvelopeAxisLimitsM = axes.map((axis) => {
    const [x, y, z] = basis[axis]
    const limit = 0.04 * Math.hypot(matrix[x], matrix[y], matrix[z])
    if (
      Math.abs(after.min[axis] - before.min[axis]) > limit ||
      Math.abs(after.max[axis] - before.max[axis]) > limit
    ) {
      throw new Error('Cactus world bounds changed')
    }
    return limit
  })
  return {
    worldEnvelopeMaxErrorM: cactusEnvelopeError(before, after),
    worldEnvelopeArtLimitM: Math.max(...worldEnvelopeAxisLimitsM),
    worldEnvelopeAxisLimitsM,
  }
}
