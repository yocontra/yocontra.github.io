/** Author both static detail variants in one glTF container, preserving their world transforms. */
import type { Node } from '@gltf-transform/core'
import {
  MODEL_LOD_PREFIX,
  type StaticModelLod,
} from '../../src/experiments/out-west/content/types.ts'
import type { FrontierGeometry, Placement, PrefabFit } from './frontier-geometry.ts'

interface Options {
  near: string
  far: string
  fit?: PrefabFit
  lod?: StaticModelLod
}
export function lodPrefab(
  g: FrontierGeometry,
  root: Node,
  area: Placement,
  options: Options,
): Node {
  const { near, far, fit = {}, lod = { distance: 28, hysteresis: 4 } } = options
  if (
    !(
      Number.isFinite(lod.distance) &&
      Number.isFinite(lod.hysteresis) &&
      lod.hysteresis > 0 &&
      lod.distance > lod.hysteresis
    )
  ) {
    throw new Error('Invalid authored model LOD distances')
  }
  const center: [number, number, number] = [
    area.x + area.w / 2,
    ((area.y0 ?? 0) + area.top) / 2,
    area.z + area.d / 2,
  ]
  const group = g.doc
    .createNode(`${MODEL_LOD_PREFIX}${lod.distance}:${lod.hysteresis}`)
    .setTranslation(center)
  root.addChild(group)
  const offset: [number, number, number] = [-center[0], -center[1], -center[2]]
  g.prefab(group, near, area, fit).setName('lod-near').setTranslation(offset)
  g.prefab(group, far, area, fit).setName('lod-far').setTranslation(offset)
  return group
}
