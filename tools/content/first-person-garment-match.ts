/** Reconcile canonical positions with tagged offline fits before indexed arm matching. */
import type { Document } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'
import { prepareNativeRiderGarmentFit, RIDER_GARMENT_FIT_VERSION } from './native-rider-garments.ts'
import { prepareShirtVestArmholeFit, SHIRT_VEST_ARMHOLE_VERSION } from './shirt-vest-armhole.ts'

export interface FittedPositions {
  positions: number[][]
  buckets: Map<string, number[]>
}

const FIT_MATERIALS = new Set(['Dyeable', 'Fabric', 'Neckerchief'])
export async function garmentMatchFrames(native: Document, source: Document, id: string) {
  const extras = native.getRoot().getExtras()
  const collar =
    extras.riderGarmentFit === RIDER_GARMENT_FIT_VERSION
      ? await prepareNativeRiderGarmentFit(id, source)
      : undefined
  const armhole =
    extras.shirtVestArmhole === SHIRT_VEST_ARMHOLE_VERSION
      ? await prepareShirtVestArmholeFit(id)
      : undefined
  const helperPins = [
    ...(collar ? ['native-rider-garments.ts'] : []),
    ...(armhole ? ['shirt-vest-armhole.ts'] : []),
  ]
  const materials = new Set(
    native
      .getRoot()
      .listMaterials()
      .map((material) => material.getName())
      .filter((name) => (collar && FIT_MATERIALS.has(name)) || (armhole && name === 'Dyeable')),
  )
  return {
    helperPins,
    resolvePositions(
      vertices: readonly { position: number[] }[],
      key: (position: number[]) => string,
    ) {
      const frames = new Map<string, FittedPositions>()
      for (const material of materials) {
        const buckets = new Map<string, number[]>()
        const positions = vertices.map(({ position }, index) => {
          const point = new Vec3(...position)
          const fit = collar?.move(point, material)
          if (fit) {
            point.add(new Vec3(...fit.delta))
          }
          const tuck = material === 'Dyeable' ? armhole?.(point) : undefined
          if (tuck) {
            point.add(new Vec3(...tuck))
          }
          const projected = fit || tuck ? point.toArray() : position
          const coordinate = key(projected)
          const bucket = buckets.get(coordinate) ?? []
          bucket.push(index)
          buckets.set(coordinate, bucket)
          return projected
        })
        frames.set(material, { buckets, positions })
      }
      return frames
    },
  }
}
